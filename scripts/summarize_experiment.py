#!/usr/bin/env python3
"""Summarize completed measurements without filling in missing runs or ratings."""
import argparse
import csv
import json
from pathlib import Path
from statistics import median

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "experiments/results"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results", type=Path, default=RESULTS)
    args = parser.parse_args()
    results = args.results.resolve()
    rows = [json.loads(line) for line in (results / "runs.jsonl").read_text().splitlines() if line.strip()]
    config = json.loads((results / "experiment-config.json").read_text())
    cases = json.loads((ROOT / "experiments/cases.json").read_text())["cases"]
    expected = {(precision, case["id"], repeat) for precision in ["F16", "Q8_0", "Q4_K_M"] for case in cases for repeat in range(1, 4)}
    actual = {(row["precision"], row["caseId"], row["repeat"]) for row in rows}
    if len(actual) != len(rows) or actual != expected or any(row["fingerprint"] != config["fingerprint"] for row in rows):
        raise SystemExit(f"Resultados incompletos/inconsistentes: {len(actual)}/135. Nenhum resultado foi inventado.")
    assessment_path = results / "quality-assessment.json"
    assessment = json.loads(assessment_path.read_text()) if assessment_path.exists() else {"ratings": []}
    ratings = assessment["ratings"]
    rated_keys = {(r["precision"], r["caseId"]) for r in ratings}
    valid_keys = {(precision, case["id"]) for precision in ["F16", "Q8_0", "Q4_K_M"] for case in cases}
    if len(rated_keys) != len(ratings) or not rated_keys <= valid_keys or any(type(r[k]) is not int or not 0 <= r[k] <= 2 for r in ratings for k in ["correctness", "grounding", "clarity"]):
        raise SystemExit("Avaliações duplicadas, inválidas ou fora da escala 0–2.")
    highwater_path = results / "memory-highwater.json"
    highwaters = json.loads(highwater_path.read_text())["records"] if highwater_path.exists() else []
    load_path = results / "load-memory.json"
    loads = json.loads(load_path.read_text()) if load_path.exists() else []
    summaries = []
    groups = []
    for precision in ["F16", "Q8_0", "Q4_K_M"]:
        runs = [r for r in rows if r["precision"] == precision]
        okay = [r for r in runs if r["status"] == "ok"]
        rated = [r for r in ratings if r["precision"] == precision]
        entry = {"precision": precision, "successful": len(okay), "failed": len(runs)-len(okay), "rated": len(rated)}
        for key, source, scale in [("firstVisibleMedianSeconds", "firstFinalTokenMs", 1000), ("totalMedianSeconds", "totalMs", 1000)]:
            entry[key] = median(r[source] for r in okay if r.get(source) is not None) / scale if okay else None
        entry["decodeMedianTokensPerSecond"] = median(r["timings"]["predicted_per_second"] for r in okay) if okay else None
        entry["prefillMedianTokensPerSecond"] = median(r["timings"]["prompt_per_second"] for r in okay) if okay else None
        entry["ramPeakMiB"] = max((r.get("ramPeakMiB", 0) for r in okay), default=0)
        entry["ramRequestSamplePeakMiB"] = entry["ramPeakMiB"]
        hwm = [r["ramHighwaterMiB"] for r in runs if r.get("ramHighwaterMiB") is not None]
        hwm += [r["ramHighwaterMiB"] for r in highwaters if r["precision"] == precision]
        entry["ramLifetimeHighwaterMiB"] = max(hwm) if hwm else None
        entry["loadMemoryProbe"] = next((r for r in loads if r["precision"] == precision), None)
        entry["vramPeakMiB"] = max((r["gpuPeakMiB"] for r in okay if r.get("gpuPeakMiB") is not None), default=None)
        entry["over150Words"] = sum(r["words"] > 150 for r in okay)
        entry["under80Words"] = sum(r["words"] < 80 for r in okay)
        for key in ["correctness", "grounding", "clarity"]:
            entry[key + "Mean"] = sum(r[key] for r in rated)/len(rated) if rated else None
        summaries.append(entry)
        for case in cases:
            group = [r for r in okay if r["caseId"] == case["id"]]
            if not group: continue
            groups.append({"precision":precision,"caseId":case["id"],"successful":len(group),
                "firstVisibleMedianSeconds":median(r["firstFinalTokenMs"] for r in group)/1000,
                "totalMedianSeconds":median(r["totalMs"] for r in group)/1000,
                "promptTokensActual":group[0]["timings"]["prompt_n"],
                "decodeMedianTokensPerSecond":median(r["timings"]["predicted_per_second"] for r in group),
                "identicalAnswersAcrossRepeats":len({r["answer"] for r in group})==1})
    summary = {"fingerprint":config["fingerprint"],"completed":len(rows),"precisions":summaries,"cases":groups,
               "qualityReviewer":assessment.get("reviewer"),"independentHumanReview":assessment.get("independentHumanReview",False)}
    (results / "summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n")
    with (results / "case-summary.csv").open("w",newline="") as file:
        writer=csv.DictWriter(file,fieldnames=list(groups[0]));writer.writeheader();writer.writerows(groups)
    with (results / "quality-reviewed.csv").open("w",newline="") as file:
        writer=csv.DictWriter(file,fieldnames=["precision","caseId","correctness","grounding","clarity","notes"])
        writer.writeheader();writer.writerows(ratings)
    print(json.dumps(summaries,ensure_ascii=False,indent=2))


if __name__ == "__main__": main()
