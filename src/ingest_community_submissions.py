#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
Ingestion script for community submissions.
Parses submitted CSV or JSON files (from Google Forms / GitHub Issue Forms)
and converts them into confirmed owner submission claim overrides.
"""

import sys
import json
import csv
import argparse
from pathlib import Path

DATA_AUTHORING_DIR = Path("data-authoring")


def ingest_submission_csv(csv_path: Path):
    if not csv_path.exists():
        print(f"Error: Submission file {csv_path} not found.")
        return

    DATA_AUTHORING_DIR.mkdir(parents=True, exist_ok=True)
    out_file = DATA_AUTHORING_DIR / "community-submissions.json"

    submissions = []
    if out_file.exists():
        try:
            with open(out_file, "r", encoding="utf-8") as f:
                submissions = json.load(f)
        except Exception:
            submissions = []

    with open(csv_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            submissions.append({
                "pokemon_name": row.get("pokemon_name") or row.get("Pokemon"),
                "attribute": row.get("attribute") or row.get("Field"),
                "value": row.get("value") or row.get("Correction"),
                "submitted_at": row.get("Timestamp"),
                "trust_tier": "confirmed_owner_submission"
            })

    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(submissions, f, indent=2, ensure_ascii=False)

    print(f"Successfully ingested submissions into {out_file}. Total submissions: {len(submissions)}")


def main():
    parser = argparse.ArgumentParser(description="Ingest Community Submissions")
    parser.add_argument("--csv", help="Path to Google Form CSV export")
    args = parser.parse_args()

    if args.csv:
        ingest_submission_csv(Path(args.csv))
    else:
        print("Usage: python src/ingest_community_submissions.py --csv <path-to-file.csv>")


if __name__ == "__main__":
    main()
