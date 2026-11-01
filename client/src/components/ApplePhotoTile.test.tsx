import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApplePhotoTile } from "./ApplePhotoTile";
import { api } from "../api/client";

describe("Apple catalog-only tile", () => {
  it("offers Photos and a separate local check without claiming an image is ready", () => {
    const html = renderToStaticMarkup(<ApplePhotoTile item={{
      uuid: "cloud", mediaType: "image", filename: "Cloud.jpg", date: "2020-08-10", latitude: 12, longitude: 34,
      mediaId: null, thumbnailVersion: 0, available: false,
    }} busy={false} onOpen={() => {}} onOpenInPhotos={() => {}} onCheckLocal={() => {}} />);
    expect(html).toContain("Image not local");
    expect(html).toContain("Open in Photos");
    expect(html).toContain("Check for local copy");
  });
});


it("offers overlay favorites for cloud stills without preparing on render", () => {
  const select = vi.spyOn(api.plugins, "selectApplePhoto");
  const favorite = vi.spyOn(api.media, "setFavorite");
  const html = renderToStaticMarkup(<ApplePhotoTile rootId={3} item={{
    uuid: "cloud", mediaType: "image", filename: "Cloud.jpg", date: null, latitude: null, longitude: null,
    mediaId: null, thumbnailVersion: 0, available: false,
  }} busy={false} onOpen={() => {}} onOpenInPhotos={() => {}} onCheckLocal={() => {}} />);
  expect(html).toContain('aria-label="Add to favorites"');
  expect(html).not.toContain('aria-label="Add to collection"');
  expect(html).toContain("Image not local");
  expect(select).not.toHaveBeenCalled();
  expect(favorite).not.toHaveBeenCalled();
  select.mockRestore(); favorite.mockRestore();
});

it("does not offer still preparation actions for videos", () => {
  const html = renderToStaticMarkup(<ApplePhotoTile rootId={3} item={{
    uuid: "movie", mediaType: "video", filename: "Movie.mov", date: null, latitude: null, longitude: null,
    mediaId: null, thumbnailVersion: 0, available: false,
  }} busy={false} onOpen={() => {}} onOpenInPhotos={() => {}} onCheckLocal={() => {}} />);
  expect(html).not.toContain('aria-label="Add to favorites"');
  expect(html).not.toContain('aria-label="Add to collection"');
});


it("keeps both selection actions disabled during another tile action", () => {
  const html = renderToStaticMarkup(<ApplePhotoTile rootId={3} item={{
    uuid: "cloud", mediaType: "image", filename: "Cloud.jpg", date: null, latitude: null, longitude: null,
    mediaId: null, thumbnailVersion: 0, available: false,
  }} busy onOpen={() => {}} onOpenInPhotos={() => {}} onCheckLocal={() => {}} />);
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Add to favorites"/);
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Check for local copy"/);
});

it("shows selection state on cloud tiles and hides favorite actions during selection", () => {
  const html = renderToStaticMarkup(<ApplePhotoTile rootId={3} item={{uuid:"cloud",mediaType:"image",filename:"Cloud.jpg",date:null,latitude:null,longitude:null,mediaId:null,thumbnailVersion:0,available:false}} busy={false} selected onSelect={()=>{}} onOpen={()=>{}} onOpenInPhotos={()=>{}} onCheckLocal={()=>{}}/>);
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain('ring-2 ring-accent');
  expect(html).not.toContain('aria-label="Add to favorites"');
});
