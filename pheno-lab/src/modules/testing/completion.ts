/** The completion scope is every allocated substrate, per requested run/card. */
export function testingCompletion(input: {
  samples: { id: string; variationGroup: string | null }[];
  requests: {
    id: string;
    runId: string;
    characterizationId: string;
    valid: boolean;
  }[];
  results: {
    sampleId: string | null;
    runId: string | null;
    characterizationId: string;
    metrics: unknown;
    source: string;
    sourceMeasurementId: string | null;
  }[];
  measurements: { id: string; sampleId: string | null; runId: string | null }[];
}) {
  const eligible = input.samples.filter((sample) => {
    const group = sample.variationGroup?.trim();
    return !!group && group !== "ERROR" && group !== "EXTRA";
  });
  const hasMetrics = (metrics: unknown) =>
    !!metrics &&
    typeof metrics === "object" &&
    !Array.isArray(metrics) &&
    Object.values(metrics).some(
      (value) =>
        (typeof value === "string" && value.trim() !== "") ||
        (typeof value === "number" && Number.isFinite(value)),
    );
  const key = (...parts: (string | null)[]) => JSON.stringify(parts);
  const measurements = new Map(input.measurements.map((m) => [m.id, m]));
  const measuredSamples = new Set(
    input.measurements.map((m) => key(m.runId, m.sampleId)),
  );
  const completedByScope = new Map<string, Set<string>>();
  for (const result of input.results) {
    if (!result.sampleId || !hasMetrics(result.metrics)) continue;
    if (result.source === "INSTRUMENT") {
      const measurement = result.sourceMeasurementId
        ? measurements.get(result.sourceMeasurementId)
        : null;
      if (
        result.sourceMeasurementId
          ? !measurement ||
            measurement.sampleId !== result.sampleId ||
            measurement.runId !== result.runId
          : !measuredSamples.has(key(result.runId, result.sampleId))
      )
        continue;
    }
    const scope = key(result.runId, result.characterizationId);
    const completed = completedByScope.get(scope) ?? new Set<string>();
    completed.add(result.sampleId);
    completedByScope.set(scope, completed);
  }
  const requests = Object.fromEntries(
    input.requests.map((request) => {
      const completed = completedByScope.get(
        key(request.runId, request.characterizationId),
      );
      return [
        request.id,
        request.valid &&
          eligible.length > 0 &&
          eligible.every((sample) => completed?.has(sample.id) === true),
      ];
    }),
  );
  return {
    complete:
      input.requests.length > 0 && Object.values(requests).every(Boolean),
    requests,
  };
}
