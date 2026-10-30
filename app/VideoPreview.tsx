"use client";

import { Video, VideoPlayer, VideoSkin } from "@videojs/react/video";
import "@videojs/react/video/skin.css";

export default function VideoPreview({ src }: { src: string }) {
  return <VideoPlayer title="VFX asset preview"><VideoSkin style={{ width: "100%", maxHeight: "calc(90vh - 42px)", aspectRatio: "16 / 9" }}><Video src={src} playsInline autoPlay controls /></VideoSkin></VideoPlayer>;
}
