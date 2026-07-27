CREATE TABLE raw_json AS
SELECT *
FROM read_json_auto('GAME_MASTER.json');

CREATE TABLE templates AS
SELECT
    templateId,
    entry.key AS record_id,
    entry.value AS json_data
FROM raw_json,
UNNEST(map_entries(data)) AS t(entry);

CREATE TABLE schema_inventory AS
SELECT
    record_id,
    COUNT(*) AS row_count,
    json_group_structure(json_data) AS structure
FROM templates
GROUP BY record_id;