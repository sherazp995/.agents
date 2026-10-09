"""Every on-disk location the hub reads or writes, rooted at one home directory."""
from dataclasses import dataclass
import os
from pathlib import Path


@dataclass(frozen=True)
class Paths:
    home: Path

    @classmethod
    def from_env(cls):
        # Tests point the whole hub at a temporary home through this variable.
        return cls(Path(os.environ.get('AGENTS_HUB_HOME', Path.home())).expanduser())

    @property
    def hub(self):
        return self.home / '.agents'

    @property
    def registry(self):
        return self.hub / 'registry.toml'

    @property
    def memory(self):
        return self.hub / 'memory'

    @property
    def scopes(self):
        return self.memory / 'scopes'

    @property
    def global_memory(self):
        return self.memory / 'global'

    @property
    def memory_lock(self):
        return self.memory / '.lock'

    @property
    def chats(self):
        return self.hub / 'chats'

    @property
    def index_db(self):
        return self.chats / 'index.sqlite'

    @property
    def index_lock(self):
        return self.chats / '.index.lock'

    @property
    def handoffs(self):
        return self.hub / 'handoffs'

    @property
    def backups(self):
        return self.hub / 'backup'

    @property
    def claude_projects(self):
        # ~/.claude1/projects is a symlink to this folder, so one path covers both logins.
        return self.home / '.claude' / 'projects'

    @property
    def codex_sessions(self):
        # ~/.codex1/sessions is a symlink to this folder.
        return self.home / '.codex' / 'sessions'

    @property
    def opencode_storage(self):
        return self.home / '.local' / 'share' / 'opencode' / 'storage'

    @property
    def aider_history(self):
        return self.home / '.aider.chat.history.md'

    @property
    def continue_sessions(self):
        return self.home / '.continue' / 'sessions'
