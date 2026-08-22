import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Home from "../app/page";
import "../app/globals.css";
import "../app/globals-enhancements.css";

const container = document.getElementById("root");
if (!container) throw new Error("Root container #root was not found.");

createRoot(container).render(
  <StrictMode>
    <Home />
  </StrictMode>,
);
