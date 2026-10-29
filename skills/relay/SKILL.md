---
name: relay
description: Message the user in Slack from any local session with `relay notify`. Use when the user asks to be told on Slack, or when a long task they are not watching finishes, gets blocked, or needs their decision. Not for chatter, progress ticks, or anything holding a secret.
---

# Relay

Relay is the Slack bot on this machine (`~/.agents/relay`). `relay notify` sends the user a Slack DM through it, so a Claude or Codex session can reach them when they are away from the terminal.

## Send a message

```sh
relay notify --peer "agents-39 [a1a227]" "Finished the rename on \`main\`: specs pass, one commit, not pushed."
relay notify --to U0123456789 "..."   # a mapped Slack user instead of the operators
relay notify --peer "agents-39 [a1a227]" --file ~/.agents/tmp/plans/x.md "Plan for the rename, ready for review."
relay live say --channel D0123 --thread 1793.1 --text "Plan attached." --file ~/.agents/tmp/plans/x.md
```

From Claude Code, pass `--peer` with this chat's own name exactly as `ListAgents` prints it on its first line ("This session is <name> [<ref>]"). Replies then reach this chat even when other chats are open in the same folder.

- With no `--to` it goes to this machine's operators, which is usually just the user.
- The running relay daemon sends it within seconds. If the daemon is down, it goes out when the daemon starts again.
- Run from a Claude Code chat, the command waits for the send (up to 30 seconds) and attaches the DM thread to this chat. `--no-attach` skips that. Codex has no `ListAgents`, so from Codex a reply starts an autonomous task.
- The CLI refuses an empty message, one over 500 characters, a `--to` user relay does not know, and a file over 1 GB (Slack's own limit).
- `--file` posts the file in the DM's thread once the DM is sent (on `live say`, after the text). Any file type works: `.md` plans, `branch-visual-qa` HTML reports (send `report-embedded.html` from `build_report.py --embed`, so the screenshots show), `video-qa` videos.
- The daemon reads the file when it uploads, so leave it in place until it is sent.

## When to send

One message per real event, when the user is not watching:

- the task is done (say what changed and anything left unverified);
- you are blocked;
- you need a decision.

Do not send progress ticks, and do not send what you are already saying in the terminal they are reading. Send only when the user asked to hear about it on Slack, or asked you to work while they are away.

## How to write it

- Anything long goes as a `.md` file with one short line of text: plans to review, reports, findings lists. The user reviews files, not walls of Slack text.

- Keep it short: one or two sentences, answer first, the way `human-conversation` says.
- Write standard Markdown, which Relay posts as a Slack markdown block: `**bold**`, `` `code` ``, `[text](https://url)`, and short `- ` bullets when you need them. Not Slack mrkdwn (`*bold*`, `<https://url|text>`). No headings, no "Status:" or "Summary:" labels.
- Never include tokens, passwords, keys or other secrets. Relay scrubs the secrets it knows about, but that is a backstop, not permission.

## Replies

A request that came over Slack is answered over Slack, every time, with no exceptions: the answer, each question back, and the final result with any files. Saying it only in the terminal does not count.

When the DM is attached, a reply in its thread comes back to this chat while it is open: relay's courier sends it in as a message, with the `relay live say` command to answer in the thread. Answer there, briefly, in the same Slack style.

Once this chat has closed, a reply becomes that thread's autonomous task. The task reads the whole thread first, so the message itself should still make sense on its own.
