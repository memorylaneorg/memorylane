import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { ConfirmProvider } from "../components/ConfirmDialog";
import FavoritesPage from "./FavoritesPage";
import HomePage from "./HomePage";

it("keeps folder browsing controls in Your Library", () => {
  const html = renderToStaticMarkup(<StaticRouter location="/"><ConfirmProvider><HomePage /></ConfirmProvider></StaticRouter>);
  expect(html).toContain("All files");
  expect(html).not.toContain("Collection name");
});

it("shows Collections beside Favorites in the Favorites destination", () => {
  const html = renderToStaticMarkup(<StaticRouter location="/collections"><ConfirmProvider><FavoritesPage /></ConfirmProvider></StaticRouter>);
  expect(html).toContain('role="tab" aria-selected="false"');
  expect(html).toContain('role="tab" aria-selected="true"');
  expect(html).toContain('aria-label="New collection"');
  expect(html).toContain("No collections yet");
  expect(html).not.toContain("All files");
});
