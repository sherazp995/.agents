import { describe, expect, it } from 'vitest'
import { describeRemoteWrite } from '../../src/autonomous/describe-write.js'

describe('describeRemoteWrite', () => {
  it.each([
    ['git push -u origin feature-x', 'Push branch feature-x to origin'],
    ['git push', 'Push the current branch to its upstream'],
    ['git -C /repo push origin HEAD', 'Push the current branch to origin'],
    ['git push --force-with-lease origin x', 'FORCE push branch x to origin'],
    ['git push -fu origin x', 'FORCE push branch x to origin'],
    ['git push origin +x', 'FORCE push branch x to origin'],
    ['git push origin --delete old', 'Delete branch old on origin'],
    ['git push origin --tags', 'Push all tags to origin'],
    ['gh pr create --title "Fix login" --body "Long\nbody" --base main', 'Open a pull request: Fix login'],
    ['gh pr create -R o/r --draft --fill', 'Open a draft pull request in o/r'],
    ['gh pr merge 12 --squash --delete-branch', 'Merge pull request #12'],
    ['gh pr comment --body "looks good"', "Comment on the current branch's pull request"],
    ['gh issue close 7 -c "done"', 'Close issue #7'],
    ['gh release create v1.2 -t "Spring" dist.tgz', 'Create release v1.2: Spring'],
    ['gh api repos/o/r/issues -f title=x', 'Call the GitHub API: POST repos/o/r/issues'],
    ['gh api --method DELETE repos/o/r/git/refs/heads/x', 'Call the GitHub API: DELETE repos/o/r/git/refs/heads/x'],
  ])('reads %s as one plain line', (command, line) => {
    expect(describeRemoteWrite(command)).toBe(line)
  })

  it.each([
    ['gh label clone o/src --repo o/dest', 'Run gh label clone (writes to GitHub)'],
    ['git push --push-option=ci.skip origin x', 'Run git push (writes to a remote)'],
    ['git push origin $BRANCH', 'Run git push (writes to a remote)'],
    ['env GIT_TRACE=1 git push origin x', 'Run git push (writes to a remote)'],
    ['gh issue comment --body hi', 'Run gh issue comment (writes to GitHub)'],
    ['git push && gh pr create', 'Run a command that writes to a remote'],
    ['git push "unterminated', 'Run a command that writes to a remote'],
  ])('falls back for a shape it does not know: %s', (command, line) => {
    expect(describeRemoteWrite(command)).toBe(line)
  })
})
