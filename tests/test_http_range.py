import http.client
import socketserver
import threading
import time
from pathlib import Path

from go_refs import GoRefsHTTPRequestHandler


class ReuseAddrTCPServer(socketserver.TCPServer):
    """TCPServer with SO_REUSEADDR enabled to prevent 'Address already in use' errors."""
    allow_reuse_address = True


def _start_server(port):
    httpd = ReuseAddrTCPServer(("", port), GoRefsHTTPRequestHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd


def test_range_request_returns_partial_content(tmp_path, monkeypatch):
    # Serve from a temp dir containing a known file so the test doesn't
    # depend on output/GoRefs_Master.duckdb existing.
    monkeypatch.chdir(tmp_path)
    (tmp_path / "output").mkdir()
    test_file = tmp_path / "output" / "GoRefs_Master.duckdb"
    test_file.write_bytes(b"0123456789ABCDEF")  # 16 bytes

    httpd = _start_server(0)  # Use port 0 to let OS assign dynamically
    time.sleep(0.2)  # let the server bind
    port = httpd.server_address[1]  # Get the assigned port
    try:
        conn = http.client.HTTPConnection("localhost", port)
        conn.request("GET", "/output/GoRefs_Master.duckdb", headers={"Range": "bytes=4-7"})
        resp = conn.getresponse()
        body = resp.read()
        assert resp.status == 206
        assert resp.getheader("Content-Range") == "bytes 4-7/16"
        assert body == b"4567"
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_range_request_open_ended(tmp_path, monkeypatch):
    # Test open-ended range: bytes=N- (from byte N to end of file)
    monkeypatch.chdir(tmp_path)
    (tmp_path / "output").mkdir()
    test_file = tmp_path / "output" / "GoRefs_Master.duckdb"
    test_file.write_bytes(b"0123456789ABCDEF")  # 16 bytes

    httpd = _start_server(0)
    time.sleep(0.2)
    port = httpd.server_address[1]
    try:
        conn = http.client.HTTPConnection("localhost", port)
        conn.request("GET", "/output/GoRefs_Master.duckdb", headers={"Range": "bytes=4-"})
        resp = conn.getresponse()
        body = resp.read()
        assert resp.status == 206
        assert resp.getheader("Content-Range") == "bytes 4-15/16"
        assert body == b"456789ABCDEF"
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_range_request_suffix(tmp_path, monkeypatch):
    # Test suffix range: bytes=-N (last N bytes of file)
    # This is how DuckDB's httpfs-style clients typically probe a file's footer
    monkeypatch.chdir(tmp_path)
    (tmp_path / "output").mkdir()
    test_file = tmp_path / "output" / "GoRefs_Master.duckdb"
    test_file.write_bytes(b"0123456789ABCDEF")  # 16 bytes

    httpd = _start_server(0)
    time.sleep(0.2)
    port = httpd.server_address[1]
    try:
        conn = http.client.HTTPConnection("localhost", port)
        conn.request("GET", "/output/GoRefs_Master.duckdb", headers={"Range": "bytes=-4"})
        resp = conn.getresponse()
        body = resp.read()
        assert resp.status == 206
        assert resp.getheader("Content-Range") == "bytes 12-15/16"
        assert body == b"CDEF"
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_range_request_invalid_header(tmp_path, monkeypatch):
    # Test malformed Range header (should return 416)
    monkeypatch.chdir(tmp_path)
    (tmp_path / "output").mkdir()
    test_file = tmp_path / "output" / "GoRefs_Master.duckdb"
    test_file.write_bytes(b"0123456789ABCDEF")  # 16 bytes

    httpd = _start_server(0)
    time.sleep(0.2)
    port = httpd.server_address[1]
    try:
        conn = http.client.HTTPConnection("localhost", port)
        conn.request("GET", "/output/GoRefs_Master.duckdb", headers={"Range": "invalid"})
        resp = conn.getresponse()
        resp.read()
        assert resp.status == 416
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_range_request_out_of_bounds(tmp_path, monkeypatch):
    # Test out-of-bounds range (should return 416 with Content-Range header)
    monkeypatch.chdir(tmp_path)
    (tmp_path / "output").mkdir()
    test_file = tmp_path / "output" / "GoRefs_Master.duckdb"
    test_file.write_bytes(b"0123456789ABCDEF")  # 16 bytes

    httpd = _start_server(0)
    time.sleep(0.2)
    port = httpd.server_address[1]
    try:
        conn = http.client.HTTPConnection("localhost", port)
        conn.request("GET", "/output/GoRefs_Master.duckdb", headers={"Range": "bytes=1000-2000"})
        resp = conn.getresponse()
        resp.read()
        assert resp.status == 416
        assert resp.getheader("Content-Range") == "bytes */16"
    finally:
        httpd.shutdown()
        httpd.server_close()
