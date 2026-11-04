import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aipster_tray.app_settings_linux import load_settings, save_settings, validate_fabric_url, SettingsError

class AppSettingsTests(unittest.TestCase):
    def test_validate_fabric_bases(self):
        self.assertEqual(validate_fabric_url("https://fabric.example/"), "https://fabric.example/v1")
        self.assertEqual(validate_fabric_url("http://localhost:8089/v1/"), "http://localhost:8089/v1")
        self.assertEqual(validate_fabric_url("http://[::1]:8089"), "http://[::1]:8089/v1")
        for bad in ("http://remote.example/v1", "https://u:p@example/v1", "https://example/v1?key=x", "https://example/v1#x", "https://example/v1/chat/completions", "https://example/healthz", "file:///v1", "https://example:99999/v1", "https://example/ v1"):
            with self.subTest(bad=bad), self.assertRaises(SettingsError):
                validate_fabric_url(bad)
        with self.assertRaises(SettingsError):
            validate_fabric_url("http://localhost:8090/v1", "http://127.0.0.1:8090")
    def test_private_roundtrip_clear_and_no_runtime_edits(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            (root/"config.toml").write_text("runtime sentinel")
            (root/"pairing.json").write_text("pairing sentinel")
            self.assertEqual(load_settings(d)["status"], "not_configured")
            with self.assertRaises(SettingsError): save_settings(d,"https://fabric.example",False)
            result=save_settings(d,"https://fabric.example",True)
            self.assertEqual(result["status"],"configured_unverified")
            self.assertEqual(load_settings(d),result)
            self.assertEqual(os.stat(root/"app-settings.json").st_mode & 0o777,0o600)
            self.assertEqual((root/"config.toml").read_text(),"runtime sentinel")
            self.assertEqual((root/"pairing.json").read_text(),"pairing sentinel")
            self.assertEqual(save_settings(d,"",False)["status"],"not_configured")
            self.assertFalse(load_settings(d)["fabric_confirmed"])
            self.assertFalse(list(root.glob(".app-settings-*")))
    def test_invalid_stored_settings_fail_closed(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/"app-settings.json"
            for raw in ('{bad',json.dumps({"fabric_base_url":"https://example/v1","fabric_confirmed":False}), '[]'):
                path.write_text(raw)
                with self.assertRaises(SettingsError): load_settings(d)
if __name__ == "__main__": unittest.main()
