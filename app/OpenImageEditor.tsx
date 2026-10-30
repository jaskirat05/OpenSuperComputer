"use client";

import { DesignEditor } from "@fastlabai/design-editor";
import { useEffect } from "react";
import "./design-editor-theme.css";

type FabricCanvasHost = HTMLDivElement & {
  __layerhubEditor?: { canvas?: { canvas?: { dispose?: () => void | Promise<boolean> } }; destroy?: () => void };
};

export default function OpenImageEditor(props: React.ComponentProps<typeof DesignEditor>) {
  useEffect(() => () => {
    const canvas = document.getElementById("layerhub_io_canvas");
    const host = canvas?.parentElement as FabricCanvasHost | null;
    const editor = host?.__layerhubEditor;
    try {
      const cleanup = editor?.canvas?.canvas?.dispose?.();
      if (cleanup && typeof cleanup.then === "function") void cleanup.catch(() => undefined);
      else editor?.destroy?.();
    } catch { /* the editor may already have disposed its Fabric canvas */ }
  }, []);

  return <DesignEditor {...props} />;
}
