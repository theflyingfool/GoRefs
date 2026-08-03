from unittest.mock import patch
import go_refs


def test_build_calls_freshness_check_even_without_fetch_flag(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "output").mkdir()
    with patch("go_refs.run_freshness_check") as mock_check, \
         patch("go_refs.load_config") as mock_load_config, \
         patch("go_refs.GoRefsMasterEngine") as mock_engine_cls, \
         patch("go_refs.run_doc_generation"):
        mock_load_config.return_value = {"sources": {}}
        mock_engine_cls.return_value.build.return_value = {}
        mock_engine_cls.return_value.db_path = tmp_path / "output" / "GoRefs_Master.duckdb"
        mock_engine_cls.return_value.export_parquet.return_value = []
        with patch("sys.argv", ["go_refs.py", "--build"]):
            go_refs.main()
        mock_check.assert_called_once()
