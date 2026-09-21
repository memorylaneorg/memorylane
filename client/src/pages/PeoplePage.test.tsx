import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import type { PersonDto } from "@memorylane/shared";
import { PersonCard } from "./PeoplePage";

const person: PersonDto = {
  id: 42,
  name: "Asha",
  autoLabel: "Person 42",
  displayName: "Asha",
  coverFaceId: null,
  faceCount: 3,
  mediaCount: 2,
  hidden: false,
};

describe("People card", () => {
  it("keeps removal separate from the link to the person", () => {
    const html = renderToStaticMarkup(
      <StaticRouter location="/people">
        <PersonCard person={person} removing={false} onRemove={() => {}} editing={false} draftName="" renaming={false} onEdit={() => {}} onNameChange={() => {}} onSave={() => {}} onCancel={() => {}} />
      </StaticRouter>,
    );

    expect(html).toContain('href="/people/42"');
    expect(html).toContain('aria-label="Remove Asha"');
    expect(html).toMatch(/<\/a>.*<button[^>]+aria-label="Remove Asha"/s);
  });

  it("offers rename from the card without following its link", () => {
    const html = renderToStaticMarkup(
      <StaticRouter location="/people">
        <PersonCard person={person} removing={false} onRemove={() => {}} editing={false} draftName="" renaming={false} onEdit={() => {}} onNameChange={() => {}} onSave={() => {}} onCancel={() => {}} />
      </StaticRouter>,
    );

    expect(html).toMatch(/<\/a>.*<button[^>]+aria-label="Rename Asha"/s);
  });

  it("shows an inline name form with save and cancel while editing", () => {
    const html = renderToStaticMarkup(
      <StaticRouter location="/people">
        <PersonCard person={person} removing={false} onRemove={() => {}} editing draftName="New name" renaming={false} onEdit={() => {}} onNameChange={() => {}} onSave={() => {}} onCancel={() => {}} />
      </StaticRouter>,
    );

    expect(html).toContain('aria-label="Name for Asha"');
    expect(html).toContain('value="New name"');
    expect(html).toContain('type="submit"');
    expect(html).toContain('>Cancel</button>');
    expect(html).not.toContain('href="/people/42"');
  });
});
