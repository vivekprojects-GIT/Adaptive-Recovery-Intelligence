import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import ConsoleApp from "./console/ConsoleApp";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ConsoleApp />
    </BrowserRouter>
  </StrictMode>,
);
