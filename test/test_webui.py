import unittest

from agent import webui


class TraceTelemetryTests(unittest.TestCase):
    def test_trace_is_normalized_and_invalid_samples_are_dropped(self):
        trace = webui._sanitize_trace([
            {"x": 10.26, "y": 20, "t_ms": 750.4},
            {"x": True, "y": 20, "t_ms": 1500},
            {"x": 30, "y": "bad", "t_ms": 2250},
            {"x": 40, "y": 50, "t_ms": -5},
        ])
        self.assertEqual(trace, [
            {"x": 10.3, "y": 20.0, "t_ms": 750},
            {"x": 40.0, "y": 50.0, "t_ms": 0},
        ])

    def test_trace_is_capped(self):
        raw = [{"x": index, "y": 1, "t_ms": index * 750} for index in range(5000)]
        self.assertEqual(len(webui._sanitize_trace(raw)), 4800)


if __name__ == "__main__":
    unittest.main()
