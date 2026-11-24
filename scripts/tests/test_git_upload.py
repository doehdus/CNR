import contextlib
import io
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

from scripts.check_git_upload import check, SOURCE_LIMIT

ROOT = Path(__file__).resolve().parents[2]


class UploadCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='upload-check-test-', dir=ROOT/'.cache')
        self.root = Path(self.temp.name)
        self.assertTrue(self.root.resolve().is_relative_to(ROOT/'.cache'))
        self.git('init', '-q')

    def tearDown(self):
        for attempt in range(10):
            try:
                self.temp.cleanup()
                return
            except PermissionError:
                if attempt == 9: raise
                time.sleep(.1)

    def git(self, *args):
        subprocess.run(['git','-c','safe.directory='+self.root.as_posix(),'-C',str(self.root),*args],check=True,capture_output=True)

    def stage(self, relative, content, force=False):
        path=self.root/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(content)
        self.git('add', *(['-f'] if force else []), '--', relative)

    def run_check(self):
        output=io.StringIO()
        with contextlib.redirect_stdout(output),contextlib.redirect_stderr(output): code=check(self.root)
        return code,output.getvalue()

    def test_large_research_data_is_allowed_but_identical_source_blob_remains_limited(self):
        content=b'1,2,3\n'*(SOURCE_LIMIT//6+1)
        self.stage('experiment/active/responses.csv',content)
        self.assertEqual(self.run_check()[0],0)
        self.stage('src/oversized.py',content)
        code,output=self.run_check();self.assertEqual(code,1);self.assertIn('10 MiB source-file limit',output)

    def test_only_index_contents_are_scanned_and_secret_values_are_never_printed(self):
        self.stage('config.py',b'print("safe")\n')
        secret=b'gh'+b'p_'+b'a'*36
        (self.root/'config.py').write_bytes(secret)
        self.assertEqual(self.run_check()[0],0)
        self.git('add','--','config.py')
        code,output=self.run_check();self.assertEqual(code,1);self.assertIn('possible GitHub token',output);self.assertNotIn(secret.decode(),output)

    def test_forced_ignored_file_is_still_rejected(self):
        self.stage('.gitignore',b'.env*\n')
        self.stage('.env.local',b'EXAMPLE=local-only\n',force=True)
        code,output=self.run_check();self.assertEqual(code,1);self.assertIn('excluded by Git ignore rules',output)


if __name__=='__main__':unittest.main()
