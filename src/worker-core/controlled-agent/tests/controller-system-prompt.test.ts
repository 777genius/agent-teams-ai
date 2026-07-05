import { describe, expect, it } from "vitest";

import { controlledAgentControllerSystemPrompt } from "../index";

describe("controlledAgentControllerSystemPrompt", () => {
  it("documents broker-only controller behavior without being the security boundary", () => {
    const prompt = controlledAgentControllerSystemPrompt();

    expect(prompt).toContain("Use only the broker/status tools");
    expect(prompt).toContain("Do not ask for raw shell");
    expect(prompt).toContain("Project Integration lifecycle");
    expect(prompt).toContain("Never read or print secrets");
  });
});

