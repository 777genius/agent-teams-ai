import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parent.parent / 'owner-spawn.py'
SPEC = importlib.util.spec_from_file_location('hostedctl_owner_spawn', SOURCE)
HELPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPER)


def spec(**env_overrides):
    env = {'PATH': '/usr/bin:/bin', 'HOME': '/home/agent', 'BUN_INSTALL': '/opt/owner/x',
           'NODE_ENV': 'production'}
    env.update(env_overrides)
    return {'ownerRoot': '/opt/owner/x', 'files': {'cli': [], 'bun': [], 'cliJs': [], 'launcher': []},
            'uid': 1000, 'gid': 1000, 'home': '/home/agent', 'env': env,
            'appMcp': None, 'nativeProviders': None, 'lease': {}, 'header': {}, 'secret': '', 'logPath': '/var/log/x',
            'stopGraceSeconds': 30}


class OwnerEnvironmentAllowlistTest(unittest.TestCase):
    def test_accepts_allowlisted_provider_credentials(self):
        self.assertEqual(HELPER.validate_spec(spec(OPENAI_API_KEY='k'))['uid'], 1000)

    def test_rejects_any_key_outside_the_allowlist(self):
        for key in ('CLAUDE_CODE_OAUTH_TOKEN', 'LD_PRELOAD', 'NODE_OPTIONS', 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL', 'CLAUDE_CONFIG_DIR'):
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'env-not-allowlisted'):
                HELPER.validate_spec(spec(**{key: 'x'}))

    def test_rejects_bun_install_outside_the_verified_owner_root(self):
        with self.assertRaisesRegex(RuntimeError, 'env-invalid'):
            HELPER.validate_spec(spec(BUN_INSTALL='/tmp/elsewhere'))


class RootChainTest(unittest.TestCase):
    def test_rejects_a_directory_not_owned_by_root(self):
        if os.geteuid() == 0:
            self.skipTest('ownership is trivially root when run as root')
        with tempfile.TemporaryDirectory(prefix='hostedctl-chain-') as root:
            with self.assertRaisesRegex(RuntimeError, 'not-root-owned|not-canonical'):
                HELPER.assert_root_chain(os.path.realpath(root))


if __name__ == '__main__':
    unittest.main()
