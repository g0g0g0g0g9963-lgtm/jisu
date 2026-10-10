import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Kiosk from "../app/kiosk";
import "../app/kiosk.css";

const container = document.getElementById("root");
if (!container) throw new Error("Root container #root was not found.");
createRoot(container).render(<StrictMode><Kiosk /></StrictMode>);
