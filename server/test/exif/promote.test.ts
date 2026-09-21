import { describe, it, expect } from "vitest";
import { ExifDateTime, type Tags } from "exiftool-vendored";
import {
  promoteTags, stripTagsForStorage, parseLeadingNumber, parseShutterSeconds,
  normalizeDriveMode, parseFlashFired, formatWallClock,
} from "../../src/exif/promote.js";

// Realistic subset of what exiftool-vendored returns for a Canon R5 CR3.
const canonTags = {
  Make: "Canon",
  Model: "Canon EOS R5",
  SerialNumber: "012345678901",
  LensModel: "RF100-500mm F4.5-7.1 L IS USM",
  LensID: "Canon RF 100-500mm F4.5-7.1L IS USM",
  LensSerialNumber: "9876543210",
  FocalLength: "500.0 mm",
  FocalLengthIn35mmFormat: "500 mm",
  FNumber: 7.1,
  ExposureTime: "1/2000",
  ShutterSpeed: "1/2000",
  ISO: 3200,
  ExposureCompensation: -0.33,
  ExposureProgram: "Manual",
  MeteringMode: "Evaluative",
  Flash: "Off, Did not fire",
  WhiteBalance: "Auto",
  DriveMode: "Continuous Shooting",
  ShutterCount: 40213,
  Rating: 3,
  Keywords: ["bird", "osprey"],
  GPSLatitude: 51.5,
  GPSLongitude: -0.12,
  GPSAltitude: 30,
  Software: "Adobe Lightroom",
  SubSecDateTimeOriginal: ExifDateTime.fromEXIF("2024:05:12 10:31:44.250+02:00"),
  DateTimeOriginal: ExifDateTime.fromEXIF("2024:05:12 10:31:44"),
  Orientation: 1,
  ThumbnailImage: "(Binary data 12345 bytes, use -b option to extract)",
  SourceFile: "/library/x.cr3",
  errors: [],
} as unknown as Tags;

describe("promoteTags", () => {
  it("promotes the common camera fields", () => {
    const p = promoteTags(canonTags);
    expect(p.cameraMake).toBe("Canon");
    expect(p.cameraModel).toBe("Canon EOS R5");
    expect(p.cameraSerial).toBe("012345678901");
    expect(p.lensId).toBe("Canon RF 100-500mm F4.5-7.1L IS USM");
    expect(p.lensSerial).toBe("9876543210");
    expect(p.focalLength).toBe(500);
    expect(p.focalLength35mm).toBe(500);
    expect(p.aperture).toBe(7.1);
    expect(p.shutterSpeedS).toBeCloseTo(1 / 2000, 8);
    expect(p.iso).toBe(3200);
    expect(p.exposureCompensation).toBe(-0.33);
    expect(p.exposureProgram).toBe("Manual");
    expect(p.flashFired).toBe(0);
    expect(p.driveMode).toBe("continuous");
    expect(p.shutterCount).toBe(40213);
    expect(p.rating).toBe(3);
    expect(p.keywords).toEqual(["bird", "osprey"]);
    expect(p.gpsLat).toBe(51.5);
    expect(p.gpsAlt).toBe(30);
    expect(p.software).toBe("Adobe Lightroom");
  });

  it("prefers the sub-second timestamp and keeps the offset separately", () => {
    const p = promoteTags(canonTags);
    expect(p.capturedAtPrecise).toBe("2024-05-12T10:31:44.250");
    expect(p.capturedTzOffset).toBe("+02:00");
  });

  it("falls back to DateTimeOriginal then CreateDate, and yields null with no date", () => {
    const noSub = { ...canonTags, SubSecDateTimeOriginal: undefined } as unknown as Tags;
    expect(promoteTags(noSub).capturedAtPrecise).toBe("2024-05-12T10:31:44.000");
    expect(promoteTags(noSub).capturedTzOffset).toBeNull();
    const onlyCreate = { CreateDate: ExifDateTime.fromEXIF("2019:01:02 03:04:05") } as unknown as Tags;
    expect(promoteTags(onlyCreate).capturedAtPrecise).toBe("2019-01-02T03:04:05.000");
    expect(promoteTags({} as Tags).capturedAtPrecise).toBeNull();
  });

  it("falls back to LensModel/Lens when LensID is absent and to Subject for keywords", () => {
    const p = promoteTags({ LensModel: "EF50mm f/1.8 STM", Subject: ["portrait"] } as unknown as Tags);
    expect(p.lensId).toBe("EF50mm f/1.8 STM");
    expect(p.keywords).toEqual(["portrait"]);
    expect(promoteTags({ Keywords: "single" } as unknown as Tags).keywords).toEqual(["single"]);
  });

  it("returns all-null fields for an empty tag set", () => {
    const p = promoteTags({} as Tags);
    expect(Object.values(p).every((v) => v === null)).toBe(true);
  });
});

describe("helpers", () => {
  it("parseLeadingNumber", () => {
    expect(parseLeadingNumber("100.0 mm")).toBe(100);
    expect(parseLeadingNumber(2.8)).toBe(2.8);
    expect(parseLeadingNumber("24")).toBe(24);
    expect(parseLeadingNumber("inf")).toBeNull();
    expect(parseLeadingNumber(undefined)).toBeNull();
  });
  it("parseShutterSeconds", () => {
    expect(parseShutterSeconds("1/250")).toBeCloseTo(0.004, 6);
    expect(parseShutterSeconds("30")).toBe(30);
    expect(parseShutterSeconds(0.5)).toBe(0.5);
    expect(parseShutterSeconds("1/2.5")).toBeCloseTo(0.4, 6);
    expect(parseShutterSeconds("Bulb")).toBeNull();
    expect(parseShutterSeconds(null)).toBeNull();
  });
  it("normalizeDriveMode", () => {
    expect(normalizeDriveMode("Continuous Shooting")).toBe("continuous");
    expect(normalizeDriveMode("Continuous High")).toBe("continuous");
    expect(normalizeDriveMode("Burst")).toBe("continuous");
    expect(normalizeDriveMode("Single Frame")).toBe("single");
    expect(normalizeDriveMode("Self-timer 10 sec")).toBe("timer");
    expect(normalizeDriveMode("Bracketing")).toBe("bracket");
    expect(normalizeDriveMode("Something Odd")).toBe("something odd");
    expect(normalizeDriveMode(undefined)).toBeNull();
  });
  it("parseFlashFired", () => {
    expect(parseFlashFired("Off, Did not fire")).toBe(0);
    expect(parseFlashFired("Auto, Did not fire")).toBe(0);
    expect(parseFlashFired("No Flash")).toBe(0);
    expect(parseFlashFired("On, Fired")).toBe(1);
    expect(parseFlashFired("Fired")).toBe(1);
    expect(parseFlashFired("Auto, Fired, Red-eye reduction")).toBe(1);
    expect(parseFlashFired(undefined)).toBeNull();
  });
  it("formatWallClock", () => {
    expect(formatWallClock(ExifDateTime.fromEXIF("2024:05:12 10:31:44.250+02:00")!)).toBe("2024-05-12T10:31:44.250");
    expect(formatWallClock(ExifDateTime.fromEXIF("2001:01:01 00:00:00")!)).toBe("2001-01-01T00:00:00.000");
  });
});

describe("stripTagsForStorage", () => {
  it("drops binary blobs, file-location keys and error arrays, and flattens date objects", () => {
    const out = stripTagsForStorage(canonTags);
    expect(out.ThumbnailImage).toBeUndefined();
    expect(out.SourceFile).toBeUndefined();
    expect(out.errors).toBeUndefined();
    expect(out.Make).toBe("Canon");
    expect(out.Keywords).toEqual(["bird", "osprey"]);
    expect(typeof out.DateTimeOriginal).toBe("string");
    expect(out.DateTimeOriginal).toBe("2024:05:12 10:31:44");
  });
});
