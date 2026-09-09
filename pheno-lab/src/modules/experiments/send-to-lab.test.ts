import { describe, expect, it } from "vitest";
import { sendToLabBlocker } from "./lifecycle-service";

// The gate the technicians asked for (使用反馈 2026-09): an experiment that
// reaches the lab has to say what it is and which 课题组 it belongs to,
// otherwise neither its report nor cross-experiment analysis can be read.
describe("sendToLabBlocker", () => {
  const ready = {
    title: "SAM 浓度对 PCE 的影响",
    projectId: "prj_1",
    isTest: false,
  };

  it("lets a titled, filed experiment through", () => {
    expect(sendToLabBlocker(ready)).toBeNull();
  });

  it("rejects the placeholder titles both defaults produce", () => {
    expect(sendToLabBlocker({ ...ready, title: "Untitled experiment" })).toBe(
      "title",
    );
    expect(
      sendToLabBlocker({ ...ready, title: "Untitled test experiment" }),
    ).toBe("title");
    // Case and stray spacing are the same placeholder.
    expect(
      sendToLabBlocker({ ...ready, title: "  untitled EXPERIMENT " }),
    ).toBe("title");
  });

  it("rejects an empty or whitespace title", () => {
    expect(sendToLabBlocker({ ...ready, title: "   " })).toBe("title");
  });

  it("requires a project on real experiments", () => {
    expect(sendToLabBlocker({ ...ready, projectId: null })).toBe("project");
  });

  it("reports the missing title first — it is the one only the author can write", () => {
    expect(
      sendToLabBlocker({
        title: "Untitled experiment",
        projectId: null,
        isTest: false,
      }),
    ).toBe("title");
  });

  it("leaves the test sandbox alone: scratch work never reaches a report", () => {
    expect(
      sendToLabBlocker({
        title: "Throughput probe",
        projectId: null,
        isTest: true,
      }),
    ).toBeNull();
  });

  it("keeps a title that merely mentions the word untitled", () => {
    expect(
      sendToLabBlocker({ ...ready, title: "Untitled experiment follow-up" }),
    ).toBeNull();
  });
});
