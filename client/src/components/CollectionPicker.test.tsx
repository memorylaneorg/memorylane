import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import CollectionPicker from "./CollectionPicker";

it("enables catalog selection without resolving identity until the picker opens", () => {
  const resolveMediaId = vi.fn(async () => 42);
  const html = renderToStaticMarkup(<CollectionPicker resolveMediaId={resolveMediaId} />);
  expect(html).not.toContain('disabled=""');
  expect(resolveMediaId).not.toHaveBeenCalled();
});
