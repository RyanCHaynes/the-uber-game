import json
import os
from io import BytesIO
import unittest
from unittest import mock
from urllib import error

from agent import llm


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class NvidiaTests(unittest.TestCase):
    def test_default_model_uses_nvidia_hosted_id(self):
        self.assertEqual(
            llm.NVIDIA_MODEL, "nvidia/nemotron-3-ultra-550b-a55b"
        )

    def test_backend_uses_nvidia_key(self):
        with mock.patch.dict(
            os.environ,
            {"NVIDIA_API_KEY": "test-key", "OPENROUTER_API_KEY": "old-key"},
            clear=True,
        ):
            self.assertEqual(llm.backend(), "nvidia")

    def test_backend_ignores_legacy_provider_settings(self):
        with mock.patch.dict(os.environ, {"AGENT_BACKEND": "api"}, clear=True):
            self.assertIsNone(llm.backend())

    @mock.patch("agent.llm.request.urlopen")
    def test_nvidia_json_request_and_usage(self, urlopen):
        urlopen.return_value = FakeResponse(
            {
                "choices": [{"message": {"content": '{"fun_score": 5}'}}],
                "usage": {"prompt_tokens": 12, "completion_tokens": 7},
            }
        )
        env = {"NVIDIA_API_KEY": "test-key"}
        with mock.patch.dict(os.environ, env, clear=True):
            text, usage = llm._call_nvidia(
                "nvidia/nemotron-3-ultra-550b-a55b",
                "Return JSON.",
                [{"role": "user", "content": "Analyze this level."}],
                max_tokens=8000,
                json_mode=True,
            )

        req = urlopen.call_args.args[0]
        body = json.loads(req.data.decode("utf-8"))
        self.assertEqual(req.full_url, "https://integrate.api.nvidia.com/v1/chat/completions")
        self.assertEqual(req.get_header("Authorization"), "Bearer test-key")
        self.assertEqual(req.get_header("Accept"), "application/json")
        self.assertEqual(body["model"], "nvidia/nemotron-3-ultra-550b-a55b")
        self.assertEqual(body["temperature"], 0.2)
        self.assertEqual(body["reasoning_effort"], "none")
        self.assertFalse(body["stream"])
        self.assertEqual(body["messages"][0]["role"], "system")
        self.assertNotIn("response_format", body)
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 900)
        self.assertEqual(text, '{"fun_score": 5}')
        self.assertEqual(
            usage,
            {"input_tokens": 12, "output_tokens": 7, "provider_attempts": 1},
        )

    @mock.patch("agent.llm.time.sleep")
    @mock.patch("agent.llm.request.urlopen")
    def test_resource_exhaustion_retries_with_backoff(self, urlopen, sleep):
        exhausted = error.HTTPError(
            llm.NVIDIA_ENDPOINT,
            500,
            "Internal Server Error",
            {},
            BytesIO(json.dumps({
                "error": {
                    "message": "ResourceExhausted: Worker local total request limit reached (39/32)"
                }
            }).encode()),
        )
        urlopen.side_effect = [
            exhausted,
            FakeResponse({
                "choices": [{"message": {"content": '{"ok": true}'}}],
                "usage": {"prompt_tokens": 2, "completion_tokens": 3},
            }),
        ]
        with mock.patch.dict(os.environ, {"NVIDIA_API_KEY": "test-key"}, clear=True):
            text, usage = llm._call_nvidia("model", "system", [], 100)

        self.assertEqual(text, '{"ok": true}')
        self.assertEqual(usage["provider_attempts"], 2)
        self.assertEqual(urlopen.call_count, 2)
        sleep.assert_called_once_with(5)

    @mock.patch("agent.llm.time.sleep")
    @mock.patch("agent.llm.request.urlopen")
    def test_retry_after_header_overrides_default_delay(self, urlopen, sleep):
        limited = error.HTTPError(
            llm.NVIDIA_ENDPOINT,
            429,
            "Too Many Requests",
            {"Retry-After": "7"},
            BytesIO(b'{"error":{"message":"rate limit reached"}}'),
        )
        urlopen.side_effect = [
            limited,
            FakeResponse({"choices": [{"message": {"content": "done"}}]}),
        ]
        with mock.patch.dict(os.environ, {"NVIDIA_API_KEY": "test-key"}, clear=True):
            llm._call_nvidia("model", "system", [], 100)

        sleep.assert_called_once_with(7.0)

    @mock.patch("agent.llm.time.sleep")
    @mock.patch("agent.llm.request.urlopen")
    def test_authentication_error_is_not_retried(self, urlopen, sleep):
        urlopen.side_effect = error.HTTPError(
            llm.NVIDIA_ENDPOINT,
            401,
            "Unauthorized",
            {},
            BytesIO(b'{"error":{"message":"invalid API key"}}'),
        )
        with mock.patch.dict(os.environ, {"NVIDIA_API_KEY": "bad-key"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "invalid API key"):
                llm._call_nvidia("model", "system", [], 100)

        self.assertEqual(urlopen.call_count, 1)
        sleep.assert_not_called()

    def test_nvidia_requires_key(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "NVIDIA_API_KEY"):
                llm._call_nvidia("model", "system", [], 100)


if __name__ == "__main__":
    unittest.main()
