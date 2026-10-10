#!/usr/bin/env python3
"""Build a portable branch QA report from a manifest and real screenshots."""
import argparse
import html
import json
import re
from pathlib import Path
from urllib.parse import quote, urlsplit

STATUSES = {'passed', 'failed', 'blocked', 'not-tested'}
CSS = '''body{max-width:1280px;margin:auto;padding:32px;background:#f5f7fb;color:#14233b;font:16px/1.55 system-ui,sans-serif}h1,h2{line-height:1.2}article,section{background:white;border:1px solid #d9e0eb;border-radius:12px;padding:24px;margin:24px 0}a{color:#164ac4}.meta{color:#526278;font-size:14px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}.pair figure{margin:0;min-width:0}.pair img{width:100%;border:1px solid #d9e0eb;border-radius:6px}.pair figcaption{font-weight:700;padding:8px 0}.status{font-weight:700}.passed{color:#17662f}.failed{color:#b01717}.blocked,.not-tested{color:#805100}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #d9e0eb;vertical-align:top}.table-wrap{overflow:auto}code{overflow-wrap:anywhere}@media(max-width:650px){body{padding:16px}section,article{padding:16px}.pair{grid-template-columns:1fr}}'''


def esc(value):
    return html.escape(str(value), quote=True)


def document(title, body):
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>{esc(title)}</title><style>{CSS}</style></head><body>{body}</body></html>')


def local_path(root, value):
    path = Path(value)
    target = (root / path).resolve()
    if path.is_absolute() or not target.is_relative_to(root) or not target.is_file():
        raise ValueError(f'Missing or unsafe report artifact: {value}')
    return target.relative_to(root).as_posix()


def link(path, label, prefix=''):
    return f'<a href="{esc(prefix + quote(path, safe="/"))}">{esc(label)}</a>'


def bullets(title, values):
    if not values:
        return ''
    return f'<section><h2>{esc(title)}</h2><ul>' + ''.join(f'<li>{esc(v)}</li>' for v in values) + '</ul></section>'


def case_html(case, prefix=''):
    status = case['status']
    body = (f'<h2>{esc(case["title"])}</h2><p class="status {status}">{esc(status)}</p>'
            f'<p class="meta">{esc(case["viewport"])} · {esc(case["role"])} · {esc(case["route"])}</p>'
            '<ol>' + ''.join(f'<li>{esc(step)}</li>' for step in case['steps']) + '</ol>'
            f'<p><strong>Before:</strong> {esc(case["before_text"])}</p>'
            f'<p><strong>After:</strong> {esc(case["after_text"])}</p>'
            f'<p><strong>Why this matters:</strong> {esc(case["why"])}</p>')
    images = []
    for side in ('before', 'after'):
        path = case.get(side + '_image')
        if path:
            url = esc(prefix + quote(path, safe='/'))
            images.append(f'<figure><figcaption>{side.title()}</figcaption><a href="{url}"><img src="{url}" alt="{esc(side.title() + ": " + case["title"])}" loading="lazy"></a></figure>')
    if len(images) == 2:
        body += '<div class="pair">' + ''.join(images) + '</div>'
    elif images:
        body += '<p>Incomplete comparison: only one original screenshot is available.</p>' + ''.join(images)
    else:
        body += '<p>No screenshot pair available. This comparison is not verified.</p>'
    return body


def validate_review(review, data, root, case_ids):
    required = ('status', 'mode', 'verdict', 'combined_status', 'combined_result', 'head_sha',
                'base_sha', 'integration_status', 'integration', 'summary', 'comments')
    for key in required:
        if key not in review:
            raise ValueError(f'Missing review field: {key}')
    for key in ('status', 'combined_status', 'integration_status'):
        if review[key] not in STATUSES:
            raise ValueError(f'Invalid review {key}')
    if review['mode'] not in {'review', 'recheck', 'reused', 'skipped'}:
        raise ValueError('Invalid review mode')
    if review['mode'] == 'skipped' and review['status'] == 'passed':
        raise ValueError('A skipped review cannot pass')
    if (review['head_sha'] != data['current']['sha'] or
            review['base_sha'] != data['base']['sha']):
        raise ValueError('Review SHAs must match the visual comparison')
    if not isinstance(review['comments'], list):
        raise ValueError('Review comments must be a list')
    seen = set()
    for comment in review['comments']:
        for key in ('id', 'title', 'severity', 'origin', 'status', 'location',
                    'sources', 'problem', 'proof', 'fix'):
            if key not in comment:
                raise ValueError(f'Missing review comment field: {key}')
        if (not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', comment['id']) or
                comment['id'] in seen):
            raise ValueError('Invalid or duplicate review comment ID')
        seen.add(comment['id'])
        if not isinstance(comment['sources'], list) or not comment['sources']:
            raise ValueError('Each review comment needs a sources list')
        for case_id in comment.get('case_ids', []):
            if case_id not in case_ids:
                raise ValueError(f'Unknown comparison case: {case_id}')
    if review['combined_status'] == 'passed':
        unresolved = any(
            str(c['origin']).lower() == 'introduced' and
            str(c['severity']).upper() in {'CRITICAL', 'BLOCKER', 'HIGH', 'MEDIUM'} and
            str(c['status']).upper() not in {'FIXED', 'DROPPED', 'N/A'}
            for c in review['comments'])
        if (review['status'] != 'passed' or review['integration_status'] != 'passed' or
                any(row['status'] != 'passed' for row in data['coverage']) or unresolved):
            raise ValueError('Combined pass conflicts with review, integration, coverage or open findings')
    for item in [review, *review['comments']]:
        for artifact in item.get('evidence', []):
            artifact['path'] = local_path(root, artifact['path'])


def artifact_links(items):
    return ' · '.join(link(item['path'], item['label']) for item in items)


def review_html(review):
    status = review['status']
    body = ('<section id="code-review"><h2>Combined QA and code review</h2>'
            f'<p class="status {review["combined_status"]}"><strong>Combined result: '
            f'{esc(review["combined_status"])}</strong></p>'
            f'<p>{esc(review["combined_result"])}</p>'
            f'<p class="status {status}">Code review: {esc(status)} · '
            f'{esc(review["verdict"])}</p>'
            f'<p class="meta">Mode: {esc(review["mode"])} · '
            f'Head: <code>{esc(review["head_sha"])}</code> · '
            f'Base: <code>{esc(review["base_sha"])}</code></p>'
            f'<p><strong>Integration check: {esc(review["integration_status"])}</strong> · '
            f'{esc(review["integration"])}</p>'
            f'<p>{esc(review["summary"])}</p>')
    if review.get('evidence'):
        body += '<p>' + artifact_links(review['evidence']) + '</p>'
    if not review['comments']:
        body += '<p>No comments recorded. See the review status and scope above.</p>'
    for comment in review['comments']:
        body += (f'<article id="finding-{esc(comment["id"])}">'
                 f'<h3>{esc(comment["id"])}: {esc(comment["title"])}</h3>'
                 f'<p><strong>{esc(comment["severity"])} · {esc(comment["origin"])} · '
                 f'{esc(comment["status"])}</strong></p>'
                 f'<p class="meta"><code>{esc(comment["location"])}</code> · '
                 f'Sources: {esc(", ".join(comment["sources"]))}</p>'
                 f'<p>{esc(comment["problem"])}</p>'
                 f'<p><strong>Proof:</strong> {esc(comment["proof"])}</p>'
                 f'<p><strong>Suggested fix / trial:</strong> {esc(comment["fix"])}</p>')
        links = [link(f'comparisons/{case_id}.html', f'Comparison: {case_id}')
                 for case_id in comment.get('case_ids', [])]
        links += [artifact_links(comment['evidence'])] if comment.get('evidence') else []
        if links:
            body += '<p>' + ' · '.join(links) + '</p>'
        body += '</article>'
    return body + '</section>'


def build(manifest):
    root = manifest.parent.resolve()
    data = json.loads(manifest.read_text())
    for key in ('title', 'base', 'current', 'method', 'coverage', 'cases'):
        if key not in data:
            raise ValueError(f'Missing manifest field: {key}')
    seen = set()
    for case in data['cases']:
        for key in ('id', 'title', 'status', 'viewport', 'role', 'route', 'steps', 'before_text', 'after_text', 'why'):
            if key not in case:
                raise ValueError(f'Missing case field: {key}')
        if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', case['id']) or case['id'] in seen:
            raise ValueError(f'Invalid or duplicate case ID: {case["id"]}')
        seen.add(case['id'])
        if case['status'] not in STATUSES:
            raise ValueError('Invalid case status')
        for side in ('before', 'after'):
            key = side + '_image'
            if case.get(key):
                case[key] = local_path(root, case[key])
            elif case['status'] in {'passed', 'failed'}:
                raise ValueError(f'{case["id"]}: {key} required for verified comparison')
    for item in data['coverage']:
        if item['status'] not in STATUSES:
            raise ValueError('Invalid coverage status')
    for item in data.get('evidence', []):
        item['path'] = local_path(root, item['path'])
    for item in data.get('live_urls', []):
        if urlsplit(item['url']).scheme not in ('http', 'https'):
            raise ValueError('Live URLs must use http or https')
    review = data.get('review')
    if review is not None:
        validate_review(review, data, root, seen)
    body = f'<h1>{esc(data["title"])}</h1>'
    for label, key in [('Before', 'base'), ('After', 'current')]:
        ref = data[key]
        body += f'<p><strong>{label}:</strong> {esc(ref["ref"])} · <code>{esc(ref["sha"])}</code></p>'
    body += f'<section><h2>Capture method</h2><p>{esc(data["method"])}</p></section>'
    body += '<section><h2>Coverage</h2><div class="table-wrap"><table><thead><tr><th>Scenario</th><th>Status</th><th>Evidence</th></tr></thead><tbody>'
    for row in data['coverage']:
        body += f'<tr><td>{esc(row["scenario"])}</td><td class="status {row["status"]}">{esc(row["status"])}</td><td>{esc(row["evidence"])}</td></tr>'
    body += '</tbody></table></div></section>'
    if review is not None:
        body += review_html(review)
    body += bullets('Findings', data.get('findings')) + bullets('Checks actually run', data.get('checks'))
    evidence = data.get('evidence', [])
    if evidence:
        body += '<section><h2>Supporting evidence</h2><p>' + ' · '.join(link(i['path'], i['label']) for i in evidence) + '</p></section>'
    pages = {}
    for case in data['cases']:
        path = f'comparisons/{case["id"]}.html'
        body += '<article>' + case_html(case) + '<p>' + link(path, 'Open comparison page') + '</p></article>'
        pages[path] = document(case['title'], '<p>' + link('index.html', 'All comparisons', '../') + '</p>' + case_html(case, '../'))
    body += bullets('How to reproduce', data.get('manual_steps'))
    if data.get('live_urls'):
        body += '<section><h2>Local test pages</h2><p>' + ' · '.join(f'<a href="{esc(i["url"])}">{esc(i["label"])}</a>' for i in data['live_urls']) + '</p></section>'
    body += bullets('Limitations and unresolved issues', data.get('limitations'))
    pages['index.html'] = document(data['title'], body)
    # Validate all artifacts before writing any page.
    for path, content in pages.items():
        target = root / path
        if not target.resolve().is_relative_to(root):
            raise ValueError(f'Unsafe output path: {path}')
    for path, content in pages.items():
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    return root / 'index.html'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    args = parser.parse_args()
    try:
        print(build(args.manifest.resolve()))
    except (ValueError, KeyError, TypeError, OSError) as error:
        parser.exit(1, f'Report build failed: {error}\n')
