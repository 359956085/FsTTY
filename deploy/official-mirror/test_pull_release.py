import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path

from pull_release import (
    API_URL,
    PUBLIC_BASE,
    MirrorError,
    expected_asset_url,
    read_json,
    record_failure,
    sync_once,
)


class FakeTransport:
    def __init__(self, version="1.6.3"):
        self.download_calls = []
        self.set_release(version)

    def set_release(self, version, *, bad_manifest=False, bad_digest=False):
        tag = "v" + version
        installer = "FsTTY_{}_x64-setup.exe".format(version)
        signature = "测试签名-" + version
        manifest = {
            "version": version,
            "notes": "测试更新",
            "pub_date": "2026-09-23T00:00:00Z",
            "platforms": {
                platform: {
                    "url": expected_asset_url(tag, installer),
                    "signature": "错误签名" if bad_manifest else signature,
                }
                for platform in ("windows-x86_64", "windows-x86_64-nsis")
            },
        }
        payloads = {
            installer: ("安装包-" + version).encode("utf-8"),
            installer + ".sig": (signature + "\n").encode("utf-8"),
            "latest.json": json.dumps(manifest, ensure_ascii=False).encode("utf-8"),
        }
        self.files = {
            expected_asset_url(tag, name): content for name, content in payloads.items()
        }
        self.release = {
            "tag_name": tag,
            "draft": False,
            "prerelease": False,
            "assets": [
                {
                    "name": name,
                    "state": "uploaded",
                    "size": len(content),
                    "digest": "sha256:" + (
                        "0" * 64 if bad_digest and name == installer
                        else hashlib.sha256(content).hexdigest()
                    ),
                    "browser_download_url": expected_asset_url(tag, name),
                }
                for name, content in payloads.items()
            ],
        }

    def fetch(self, url, max_bytes):
        if url != API_URL:
            raise AssertionError("不应请求其他 API 地址")
        content = json.dumps(self.release).encode("utf-8")
        if len(content) > max_bytes:
            raise AssertionError("测试响应超过上限")
        return content

    def download(self, url, target, max_bytes):
        self.download_calls.append(url)
        content = self.files[url]
        if len(content) > max_bytes:
            raise AssertionError("测试附件超过上限")
        target.write_bytes(content)
        return len(content), hashlib.sha256(content).hexdigest()


class MirrorSyncTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)

    def tearDown(self):
        self.directory.cleanup()

    def latest(self):
        return read_json(self.root / "public" / "updater" / "latest.json")

    def test_sync_rewrites_both_platforms_and_reuses_same_release(self):
        transport = FakeTransport()
        self.assertEqual(sync_once(self.root, transport), "1.6.3")
        manifest = self.latest()
        expected_url = PUBLIC_BASE + "/releases/v1.6.3/FsTTY_1.6.3_x64-setup.exe"
        self.assertEqual(
            {item["url"] for item in manifest["platforms"].values()},
            {expected_url},
        )
        self.assertEqual(len(transport.download_calls), 3)
        self.assertEqual(sync_once(self.root, transport), "1.6.3")
        self.assertEqual(len(transport.download_calls), 3)
        state = read_json(self.root / "state" / "status.json")
        self.assertEqual(state["lastSuccessVersion"], "1.6.3")
        self.assertIsNone(state["lastError"])

    @unittest.skipUnless(os.name == "posix", "POSIX 文件权限测试")
    def test_published_release_directory_is_readable_by_web_server(self):
        transport = FakeTransport()
        sync_once(self.root, transport)
        release_dir = self.root / "public" / "releases" / "v1.6.3"
        self.assertEqual(release_dir.stat().st_mode & 0o755, 0o755)

    def test_bad_digest_keeps_previous_manifest(self):
        transport = FakeTransport()
        sync_once(self.root, transport)
        previous = self.latest()
        transport.set_release("1.6.4", bad_digest=True)
        with self.assertRaisesRegex(MirrorError, "摘要不匹配"):
            sync_once(self.root, transport)
        self.assertEqual(self.latest(), previous)
        self.assertFalse((self.root / "public" / "releases" / "v1.6.4").exists())

    def test_bad_signature_and_missing_asset_keep_previous_manifest(self):
        transport = FakeTransport()
        sync_once(self.root, transport)
        previous = self.latest()
        transport.set_release("1.6.4", bad_manifest=True)
        with self.assertRaisesRegex(MirrorError, "签名与 .sig 不一致"):
            sync_once(self.root, transport)
        self.assertEqual(self.latest(), previous)
        transport.set_release("1.6.4")
        transport.release["assets"].pop()
        with self.assertRaisesRegex(MirrorError, "缺少安装包、签名或更新元数据"):
            sync_once(self.root, transport)
        self.assertEqual(self.latest(), previous)

    def test_rejects_same_version_replacement_and_older_release(self):
        transport = FakeTransport()
        sync_once(self.root, transport)
        transport.set_release("1.6.3", bad_digest=True)
        with self.assertRaisesRegex(MirrorError, "同版本 GitHub 附件摘要已变化"):
            sync_once(self.root, transport)
        transport.set_release("1.6.2")
        with self.assertRaisesRegex(MirrorError, "拒绝自动回退"):
            sync_once(self.root, transport)
        self.assertEqual(self.latest()["version"], "1.6.3")

    def test_records_failure_without_losing_last_success(self):
        transport = FakeTransport()
        sync_once(self.root, transport)
        record_failure(self.root, "测试网络故障")
        state = read_json(self.root / "state" / "status.json")
        self.assertEqual(state["lastSuccessVersion"], "1.6.3")
        self.assertEqual(state["lastError"], "测试网络故障")
        self.assertEqual(self.latest()["version"], "1.6.3")

    def test_recovers_after_manifest_promotion_before_state_write(self):
        transport = FakeTransport()
        sync_once(self.root, transport)
        old_state = read_json(self.root / "state" / "status.json")
        transport.set_release("1.6.4")
        sync_once(self.root, transport)
        calls = len(transport.download_calls)
        (self.root / "state" / "status.json").write_text(
            json.dumps(old_state), encoding="utf-8",
        )
        self.assertEqual(sync_once(self.root, transport), "1.6.4")
        self.assertEqual(len(transport.download_calls), calls)
        self.assertEqual(
            read_json(self.root / "state" / "status.json")["lastSuccessVersion"],
            "1.6.4",
        )


if __name__ == "__main__":
    unittest.main()
