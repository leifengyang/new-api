// Copyright (C) 2026 QuantumNous. Licensed under AGPL-3.0-or-later.
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { createHashRouter, Navigate, Outlet, RouterProvider } from "react-router-dom";
import { AppProviders } from "@workbench/components/layout/app-providers";
import { AgentPanel } from "@workbench/components/agent/agent-panel";
import CanvasPage from "@infinite-canvas/workbench/pages/canvas";
import CanvasProjectPage from "@infinite-canvas/workbench/pages/canvas/project";
import AssetsPage from "@infinite-canvas/workbench/pages/assets";
import "@infinite-canvas/workbench/styles/app.css";

export function Frame() {
  useEffect(() => {
    window.parent.postMessage({ type: "newapi-canvas-ready" }, location.origin);
  }, []);
  return <div className="flex h-dvh min-h-0 overflow-hidden bg-background text-foreground">
    <div className="min-h-0 min-w-0 flex-1"><Outlet /></div>
    <AgentPanel />
  </div>;
}

const router = createHashRouter([{
  element: <Frame />,
  children: [
    { path: "/", element: <Navigate to="/canvas" replace /> },
    { path: "/canvas", element: <CanvasPage /> },
    { path: "/canvas/:id", element: <CanvasProjectPage /> },
    { path: "/assets", element: <AssetsPage /> },
    { path: "*", element: <Navigate to="/canvas" replace /> },
  ],
}]);

const rootElement = document.querySelector("#root");
if (!rootElement) throw new Error("CANVAS_ROOT_MISSING");
createRoot(rootElement).render(<AppProviders><RouterProvider router={router} /></AppProviders>);
