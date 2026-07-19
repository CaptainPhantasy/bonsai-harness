import { describe, expect, test } from "bun:test";

import {
  ALL_MEDIA_MODES,
  checkMediaGate,
  isMediaMode,
  isMediaToolName,
  mediaToolMode,
} from "../src/media-policy";

describe("isMediaMode", () => {
  test("accepts the four canonical modes", () => {
    expect(isMediaMode("image")).toBe(true);
    expect(isMediaMode("video")).toBe(true);
    expect(isMediaMode("audio")).toBe(true);
    expect(isMediaMode("music")).toBe(true);
  });

  test("rejects anything else", () => {
    expect(isMediaMode("")).toBe(false);
    expect(isMediaMode("media")).toBe(false);
    expect(isMediaMode(undefined)).toBe(false);
    expect(isMediaMode(42)).toBe(false);
  });

  test("ALL_MEDIA_MODES covers exactly the four canonical modes", () => {
    expect([...ALL_MEDIA_MODES].sort()).toEqual(["audio", "image", "music", "video"]);
  });
});

describe("isMediaToolName / mediaToolMode", () => {
  test("classifies known video tools", () => {
    expect(isMediaToolName("hailuo__generate_video")).toBe(true);
    expect(mediaToolMode("hailuo__generate_video")).toBe("video");
    expect(mediaToolMode("minimax__video_gen")).toBe("video");
    expect(mediaToolMode("tools__text_to_video")).toBe("video");
  });

  test("classifies known image tools", () => {
    expect(mediaToolMode("image_gen__create")).toBe("image");
    expect(mediaToolMode("tools__text_to_image")).toBe("image");
    expect(mediaToolMode("dall_e__generate")).toBe("image");
  });

  test("classifies known audio tools (TTS, speech, voice)", () => {
    expect(mediaToolMode("tools__text_to_speech")).toBe("audio");
    expect(mediaToolMode("tts__speak")).toBe("audio");
    expect(mediaToolMode("speech_gen__narrate")).toBe("audio");
    expect(mediaToolMode("voice_clone__replicate")).toBe("audio");
    expect(mediaToolMode("voice_design__create")).toBe("audio");
  });

  test("classifies known music tools", () => {
    expect(mediaToolMode("music_gen__compose")).toBe("music");
    expect(mediaToolMode("generate_music__track")).toBe("music");
    expect(mediaToolMode("song_gen__intro")).toBe("music");
  });

  test("does not classify non-media tools", () => {
    expect(isMediaToolName("read_file")).toBe(false);
    expect(isMediaToolName("search_code")).toBe(false);
    expect(isMediaToolName("write_file")).toBe(false);
    expect(isMediaToolName("summarize_text")).toBe(false);
    expect(isMediaToolName("")).toBe(false);
    expect(mediaToolMode("read_file")).toBeUndefined();
  });
});

describe("checkMediaGate", () => {
  test("non-media tools always pass regardless of active mode", () => {
    expect(checkMediaGate(undefined, "read_file").allowed).toBe(true);
    expect(checkMediaGate("image", "write_file").allowed).toBe(true);
    expect(checkMediaGate("video", "search_code").allowed).toBe(true);
  });

  test("media tool blocked when no mode is active — the core contract", () => {
    // This is the scenario the operator was emphatic about: the model
    // sees "draw a cat" or just "cat" and tries to call image_gen.
    // No media mode active = blocked, always, regardless of phrasing.
    const gate = checkMediaGate(undefined, "image_gen__create");
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) {
      expect(gate.toolMode).toBe("image");
      expect(gate.activeMode).toBeUndefined();
      expect(gate.reason).toContain("no media mode is active");
      expect(gate.reason).toContain("ASK");
    }
  });

  test("media tool passes when the matching mode is active", () => {
    expect(checkMediaGate("image", "image_gen__create").allowed).toBe(true);
    expect(checkMediaGate("video", "hailuo__generate_video").allowed).toBe(true);
    expect(checkMediaGate("audio", "tts__speak").allowed).toBe(true);
    expect(checkMediaGate("music", "music_gen__compose").allowed).toBe(true);
  });

  test("media tool blocked when a DIFFERENT mode is active", () => {
    // User activated "image" but model tried to call a video tool.
    // Block — the user is in control of which Credit pool is eligible.
    const gate = checkMediaGate("image", "hailuo__generate_video");
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) {
      expect(gate.toolMode).toBe("video");
      expect(gate.activeMode).toBe("image");
      expect(gate.reason).toContain("user explicitly activated image");
      expect(gate.reason).toContain("Ask the user to switch modes");
    }
  });

  test("every media tool is blocked when activeMode is undefined", () => {
    // Exhaustive check: no mode active, every media tool family blocks.
    expect(checkMediaGate(undefined, "image_gen__create").allowed).toBe(false);
    expect(checkMediaGate(undefined, "hailuo__generate_video").allowed).toBe(false);
    expect(checkMediaGate(undefined, "tts__speak").allowed).toBe(false);
    expect(checkMediaGate(undefined, "music_gen__compose").allowed).toBe(false);
    expect(checkMediaGate(undefined, "voice_clone__replicate").allowed).toBe(false);
  });
});
