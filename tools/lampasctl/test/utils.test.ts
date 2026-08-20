import { describe, expect, test } from "bun:test";
import { withAbortTimeout } from "../src/utils";

describe("withAbortTimeout", () => {
  test("aborts an operation whose response body never completes", async () => {
    let wasAborted = false;

    const operation = withAbortTimeout(
      "reading a test response body",
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              wasAborted = true;
              reject(signal.reason);
            },
            { once: true }
          );
        }),
      10
    );

    await expect(operation).rejects.toThrow("Timed out after 10ms while reading a test response body");
    expect(wasAborted).toBe(true);
  });
});
