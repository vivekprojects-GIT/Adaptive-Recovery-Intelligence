import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { TooltipProvider } from "@/components/ui/tooltip";

import ConsoleApp from "./console/ConsoleApp";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <TooltipProvider delayDuration={300}>
        <ConsoleApp />
      </TooltipProvider>
    </BrowserRouter>
  </StrictMode>,
);
