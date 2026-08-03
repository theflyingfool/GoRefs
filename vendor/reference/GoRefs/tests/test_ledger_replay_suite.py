import duckdb
from scripts.user_source_coverage_test import LedgerReplayTester


def test_replay_reports_zero_gaps_when_ledger_matches_canonical(tmp_path):
    db_path = tmp_path / "test.duckdb"
    con = duckdb.connect(str(db_path))
    con.execute("CREATE TABLE species (dex_number INT, base_attack INT)")
    con.execute("INSERT INTO species VALUES (1, 118)")
    con.execute("CREATE TABLE _claims_ledger (entity_id VARCHAR, attribute VARCHAR, source VARCHAR, value VARCHAR, priority INT)")
    con.execute("INSERT INTO _claims_ledger VALUES ('pokemon_dex_1', 'base_attack', 'alexelgt_game_masters', '118', 2)")
    con.execute("INSERT INTO _claims_ledger VALUES ('pokemon_dex_1', 'base_attack', 'pogoapi_net', '999', 6)")
    con.close()

    tester = LedgerReplayTester(db_path=db_path)
    results = tester.run_suite()

    assert results["total_gaps"] == 0
    assert results["by_source"]["alexelgt_game_masters"]["matched"] == 1
    assert results["by_source"]["pogoapi_net"]["overridden"] == 1


def test_same_source_loser_surfaces_as_collision_not_overridden_or_gap(tmp_path):
    """Two disagreeing claims from the SAME source can only happen if entity_id
    is colliding across two logically-different real-world things (one source
    shouldn't have two opinions about one real entity's attribute). That must
    surface as its own 'collision' bucket -- not silently absorbed into
    'overridden' (indistinguishable from a legitimate cross-source override)
    and not miscounted as a 'gap' (the winner's value did land in canonical)."""
    db_path = tmp_path / "test.duckdb"
    con = duckdb.connect(str(db_path))
    con.execute("CREATE TABLE badges (badge_id VARCHAR, description VARCHAR)")
    con.execute("INSERT INTO badges VALUES ('City Pass', 'Winner Desc')")
    con.execute("CREATE TABLE _claims_ledger (entity_id VARCHAR, attribute VARCHAR, source VARCHAR, value VARCHAR, priority INT)")
    con.execute("INSERT INTO _claims_ledger VALUES ('badge_City Pass', 'description', 'pogoapi_net', 'Winner Desc', 6)")
    con.execute("INSERT INTO _claims_ledger VALUES ('badge_City Pass', 'description', 'pogoapi_net', 'Loser Desc', 6)")
    con.close()

    tester = LedgerReplayTester(db_path=db_path)
    results = tester.run_suite()

    assert results["total_gaps"] == 0
    assert results["by_source"]["pogoapi_net"]["matched"] == 1
    assert results["by_source"]["pogoapi_net"]["collision"] == 1
    assert results["by_source"]["pogoapi_net"]["overridden"] == 0


def test_list_valued_attribute_matches_canonical_list_column(tmp_path):
    """Canonical VARCHAR[] columns come back from duckdb/pandas as numpy arrays;
    the ledger stores the stringified Python list. Comparison must normalize
    both sides instead of comparing str(list) to str(numpy array)."""
    db_path = tmp_path / "test.duckdb"
    con = duckdb.connect(str(db_path))
    con.execute("CREATE TABLE species (dex_number INT, types VARCHAR[])")
    con.execute("INSERT INTO species VALUES (1, ['Grass', 'Poison'])")
    con.execute("CREATE TABLE _claims_ledger (entity_id VARCHAR, attribute VARCHAR, source VARCHAR, value VARCHAR, priority INT)")
    con.execute("INSERT INTO _claims_ledger VALUES ('pokemon_dex_1', 'types', 'pokemon_go_api', $$['Grass', 'Poison']$$, 3)")
    con.close()

    tester = LedgerReplayTester(db_path=db_path)
    results = tester.run_suite()

    assert results["total_gaps"] == 0
    assert results["by_source"]["pokemon_go_api"]["matched"] == 1


def test_primary_and_secondary_type_raw_claims_match_combined_types_column(tmp_path):
    """pokemon_go_api's pokedex template emits raw 'POKEMON_TYPE_x' claims as two
    separate attributes, primary_type_raw/secondary_type_raw, which builder.py
    combines (strip 'POKEMON_TYPE_', capitalize) into the single canonical
    `types` list column. Neither claim equals the whole list on its own, so the
    replay suite must check list membership instead of whole-value equality --
    without this, both claims were misreported as gaps (1024 + 526 = 1550
    exactly, one such claim per species)."""
    db_path = tmp_path / "test.duckdb"
    con = duckdb.connect(str(db_path))
    con.execute("CREATE TABLE species (dex_number INT, types VARCHAR[])")
    con.execute("INSERT INTO species VALUES (1, ['Grass', 'Poison'])")
    con.execute("CREATE TABLE _claims_ledger (entity_id VARCHAR, attribute VARCHAR, source VARCHAR, value VARCHAR, priority INT)")
    con.execute("INSERT INTO _claims_ledger VALUES ('pokemon_dex_1', 'primary_type_raw', 'pokemon_go_api', 'POKEMON_TYPE_GRASS', 3)")
    con.execute("INSERT INTO _claims_ledger VALUES ('pokemon_dex_1', 'secondary_type_raw', 'pokemon_go_api', 'POKEMON_TYPE_POISON', 3)")
    con.close()

    tester = LedgerReplayTester(db_path=db_path)
    results = tester.run_suite()

    assert results["total_gaps"] == 0
    assert results["by_source"]["pokemon_go_api"]["matched"] == 2


def test_mismatched_type_raw_claim_still_reports_as_a_genuine_gap(tmp_path):
    """A primary_type_raw/secondary_type_raw claim whose transformed value is
    NOT a member of the canonical `types` list must still be reported as a
    gap -- the new list-membership handling must not blanket-approve every
    claim with one of these two attribute names."""
    db_path = tmp_path / "test.duckdb"
    con = duckdb.connect(str(db_path))
    con.execute("CREATE TABLE species (dex_number INT, types VARCHAR[])")
    con.execute("INSERT INTO species VALUES (1, ['Grass', 'Poison'])")
    con.execute("CREATE TABLE _claims_ledger (entity_id VARCHAR, attribute VARCHAR, source VARCHAR, value VARCHAR, priority INT)")
    con.execute("INSERT INTO _claims_ledger VALUES ('pokemon_dex_1', 'primary_type_raw', 'pokemon_go_api', 'POKEMON_TYPE_FIRE', 3)")
    con.close()

    tester = LedgerReplayTester(db_path=db_path)
    results = tester.run_suite()

    assert results["total_gaps"] == 1
    assert results["by_source"]["pokemon_go_api"]["gaps"] == 1


def test_generation_claim_aliases_to_gen_canonical_column(tmp_path):
    """The resolver deliberately renames the 'generation' claim attribute to the
    canonical 'gen' column (builder.py's species-assembly loop); the replay
    suite must know about that rename or it will misreport a real match as a gap."""
    db_path = tmp_path / "test.duckdb"
    con = duckdb.connect(str(db_path))
    con.execute("CREATE TABLE species (dex_number INT, gen INT)")
    con.execute("INSERT INTO species VALUES (1, 1)")
    con.execute("CREATE TABLE _claims_ledger (entity_id VARCHAR, attribute VARCHAR, source VARCHAR, value VARCHAR, priority INT)")
    con.execute("INSERT INTO _claims_ledger VALUES ('pokemon_dex_1', 'generation', 'pokemon_go_api', '1', 3)")
    con.close()

    tester = LedgerReplayTester(db_path=db_path)
    results = tester.run_suite()

    assert results["total_gaps"] == 0
    assert results["by_source"]["pokemon_go_api"]["matched"] == 1
