import { describe, expect, it } from "vitest";
import { en } from "./resources/en";
import { es } from "./resources/es";
import { fr } from "./resources/fr";
import { resourceParityErrors } from "./parity";

describe("translation resources", () => {
  it.each([["es", es], ["fr", fr]] as const)("keeps %s keys and placeholders aligned with English", (language, resource) => {
    expect(resourceParityErrors(en, resource, language)).toEqual([]);
  });
});
