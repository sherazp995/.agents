"""update-ponytail.sh against a temporary home and a local fake upstream; no network."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

HUB = Path(__file__).resolve().parents[2]
SCRIPT = HUB / 'update-ponytail.sh'
PATCH = HUB / 'ponytail-explicit-only.patch'
SKILLS = ['ponytail', 'ponytail-audit', 'ponytail-debt', 'ponytail-gain', 'ponytail-help', 'ponytail-review']

FAKE_CODEX = '''#!/bin/sh
# Stub Codex: "plugin add" copies the shared plugin into the cache, like the real one.
[ "$1 $2" = "plugin add" ] || exit 2
version=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" \
  "$HOME/.agents/plugins/ponytail/.claude-plugin/plugin.json")
root="$HOME/.codex/plugins/cache/ponytail/ponytail/$version"
mkdir -p "$(dirname "$root")"
if [ -n "$FAKE_CODEX_BREAK" ]; then
  echo broken > "$root"   # a file where the cache folder belongs: the script fails after this
else
  mkdir -p "$root" && cp -R "$HOME/.agents/plugins/ponytail/." "$root/"
fi
'''


def upstream_originals(patch_text):
    """Rebuild the upstream ('a/') side of every file the patch edits, padding gaps."""
    files, current, hunk_old = {}, None, None
    for line in patch_text.splitlines(keepends=True):
        if line.startswith('--- a/'):
            current = line[6:].split('\t')[0].strip()
        elif line.startswith('+++ '):
            continue
        elif line.startswith('@@'):
            start = int(re.match(r'@@ -(\d+)', line).group(1))
            if start == 0:
                current = None  # the patch creates this file
                continue
            lines = files.setdefault(current, [])
            lines.extend(f'upstream filler {len(lines) + 1}\n' for _ in range(start - 1 - len(lines)))
        elif current and line[:1] in (' ', '-'):
            files[current].append(line[1:])
    return {name: ''.join(lines) for name, lines in files.items()}


def git(cwd, *args):
    subprocess.run(['git', *args], cwd=cwd, check=True, capture_output=True,
                   env={**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t',
                        'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t'})


class UpdatePonytailTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name).resolve()
        self.home = root / 'home'
        self.hub = self.home / '.agents'
        (self.hub / 'skills').mkdir(parents=True)
        for name in ('update-ponytail.sh', 'ponytail-explicit-only.patch', 'selected-skills.json', 'ponytail.json'):
            shutil.copy2(HUB / name, self.hub / name)
        (self.hub / 'check.py').write_text('open(__file__ + ".ran", "w").close()\n')
        (self.home / '.claude').mkdir()

        self.upstream = root / 'upstream'
        self.upstream.mkdir()
        for name, text in upstream_originals(PATCH.read_text()).items():
            (self.upstream / name).parent.mkdir(parents=True, exist_ok=True)
            (self.upstream / name).write_text(text)
        git(self.upstream, 'init', '-q', '-b', 'main')
        self.release('1.0.0')

        self.bin = root / 'bin'
        self.bin.mkdir()
        self.codex = self.bin / 'codex'
        self.codex.write_text(FAKE_CODEX)
        self.codex.chmod(0o755)

    def tearDown(self):
        self.tmp.cleanup()

    def release(self, version):
        for folder in ('.claude-plugin', '.codex-plugin'):
            (self.upstream / folder).mkdir(exist_ok=True)
            (self.upstream / folder / 'plugin.json').write_text(json.dumps({'name': 'ponytail', 'version': version}))
        git(self.upstream, 'add', '-A')
        git(self.upstream, 'commit', '-q', '-m', version)
        git(self.upstream, 'tag', f'v{version}')

    def run_script(self, ref='main', codex=True, **env):
        path = f'{self.bin}:/usr/bin:/bin:/usr/sbin:/sbin' if codex else '/usr/bin:/bin:/usr/sbin:/sbin'
        return subprocess.run(['bash', str(self.hub / 'update-ponytail.sh'), ref], capture_output=True, text=True,
                              env={'HOME': str(self.home), 'PATH': path, 'PONYTAIL_REPO': self.upstream.as_uri(),
                                   **env})

    def version(self, path):
        return json.loads((path / '.claude-plugin/plugin.json').read_text())['version']

    def assert_installed(self, version, codex=True):
        shared = self.hub / 'plugins/ponytail'
        self.assertEqual(self.version(shared), version)
        self.assertIn('agents/openai.yaml', {str(p.relative_to(shared / 'skills/ponytail')) for p in
                                             (shared / 'skills/ponytail').rglob('*')})  # patch applied
        for name in SKILLS:
            link = self.hub / 'skills' / name
            self.assertEqual(os.readlink(link), f'../plugins/ponytail/skills/{name}')
            self.assertEqual(link.resolve(strict=True), shared / 'skills' / name)
        config = self.home / '.config/ponytail/config.json'
        self.assertEqual(config.resolve(strict=True), self.hub / 'ponytail.json')
        claude_link = self.home / f'.claude/plugins/cache/ponytail/ponytail/{version}'
        self.assertEqual(claude_link.resolve(strict=True), shared)
        records = json.loads((self.home / '.claude/plugins/installed_plugins.json').read_text())
        [record] = records['plugins']['ponytail@ponytail']
        self.assertEqual((record['version'], record['installPath'], record['scope']),
                         (version, str(claude_link), 'user'))
        selected = json.loads((self.hub / 'selected-skills.json').read_text())
        self.assertEqual(selected['ponytail_plugin_paths'], [f'.claude/plugins/cache/ponytail/ponytail/{version}',
                                                             f'.codex/plugins/cache/ponytail/ponytail/{version}'])
        cache = self.home / '.codex/plugins/cache/ponytail/ponytail'
        if codex:
            self.assertEqual(sorted(p.name for p in cache.iterdir()), [version])
            self.assertEqual(self.version(cache / version), version)
        else:
            self.assertFalse(cache.exists())

    def test_fresh_install_with_codex_then_rerun_changes_nothing(self):
        first = self.run_script()
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assert_installed('1.0.0')
        self.assertTrue((self.hub / 'check.py.ran').exists())

        second = self.run_script()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assert_installed('1.0.0')

    def test_fresh_install_without_codex_or_claude(self):
        shutil.rmtree(self.home / '.claude')

        result = self.run_script(codex=False)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Skipping Codex', result.stdout)
        self.assertIn('Skipping Claude Code', result.stdout)
        self.assertFalse((self.home / '.claude').exists())
        self.assertEqual(self.version(self.hub / 'plugins/ponytail'), '1.0.0')
        self.assertEqual((self.hub / 'skills/ponytail').resolve(strict=True),
                         self.hub / 'plugins/ponytail/skills/ponytail')

    def test_fresh_install_without_codex_keeps_claude(self):
        result = self.run_script(codex=False)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Skipping Codex', result.stdout)
        self.assert_installed('1.0.0', codex=False)

    def test_failure_after_replacing_the_shared_copy_restores_the_previous_version(self):
        self.assertEqual(self.run_script().returncode, 0)
        installed_before = (self.home / '.claude/plugins/installed_plugins.json').read_text()
        selected_before = (self.hub / 'selected-skills.json').read_text()
        self.release('2.0.0')
        (self.hub / 'check.py.ran').unlink()

        result = self.run_script(FAKE_CODEX_BREAK='1')

        self.assertNotEqual(result.returncode, 0)
        self.assertIn('restored the previous Ponytail state', result.stderr)
        shared = self.hub / 'plugins/ponytail'
        self.assertEqual(self.version(shared), '1.0.0')
        self.assertEqual(sorted(p.name for p in shared.iterdir()),
                         sorted(p.name for p in (self.upstream).iterdir() if p.name != '.git'))
        self.assertEqual((self.home / '.claude/plugins/installed_plugins.json').read_text(), installed_before)
        self.assertEqual((self.hub / 'selected-skills.json').read_text(), selected_before)
        self.assertFalse((self.home / '.claude/plugins/cache/ponytail/ponytail/2.0.0').is_symlink())
        self.assertTrue((self.home / '.codex/plugins/cache/ponytail/ponytail/1.0.0').is_dir())
        self.assertFalse((self.hub / 'check.py.ran').exists())

    def test_failure_on_first_install_leaves_no_partial_install(self):
        result = self.run_script(FAKE_CODEX_BREAK='1')

        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.hub / 'plugins/ponytail').exists())
        self.assertFalse(any((self.hub / 'skills').iterdir()))
        self.assertFalse((self.home / '.config/ponytail/config.json').is_symlink())
        self.assertFalse((self.home / '.claude/plugins/installed_plugins.json').exists())

    def test_a_foreign_file_at_a_skill_link_path_is_left_untouched(self):
        foreign = self.hub / 'skills/ponytail-gain'
        foreign.mkdir()
        (foreign / 'SKILL.md').write_text('mine')

        result = self.run_script()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(str(foreign), result.stderr)
        self.assertNotIn('restored', result.stderr)
        self.assertEqual((foreign / 'SKILL.md').read_text(), 'mine')
        self.assertFalse((self.hub / 'plugins/ponytail').exists())
        self.assertFalse((self.hub / 'backup').exists())

    def test_a_foreign_ponytail_config_is_left_untouched(self):
        config = self.home / '.config/ponytail/config.json'
        config.parent.mkdir(parents=True)
        config.write_text('{"defaultMode": "on"}')

        result = self.run_script()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(str(config), result.stderr)
        self.assertIn('Nothing changed', result.stderr)
        self.assertEqual(config.read_text(), '{"defaultMode": "on"}')
        self.assertFalse((self.hub / 'plugins/ponytail').exists())

    def test_a_stale_link_into_the_plugin_is_repaired(self):
        (self.hub / 'skills/ponytail').symlink_to(self.hub / 'plugins/ponytail/skills/old-name')

        result = self.run_script()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_installed('1.0.0')


if __name__ == '__main__':
    unittest.main()
