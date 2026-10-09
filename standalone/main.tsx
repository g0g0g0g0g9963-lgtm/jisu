import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import Home from "../app/page";
import "../app/globals.css";
import "../app/globals-enhancements.css";
import "../app/my-bookings-buttons.css";
import "../app/responsive.css";
import "../app/ux-ui-improvements.css";
import "../app/timetable-24h.css";
import "../app/convenience.css";

const container = document.getElementById("root");
if (!container) throw new Error("Root container #root was not found.");
const Admin = lazy(() => import("../app/admin"));
const isAdminPath = /^\/admin(?:\/|$)/i.test(window.location.pathname);
if (isAdminPath) document.documentElement.classList.add("admin-document");

createRoot(container).render(
  <StrictMode>
    {isAdminPath ? <Suspense fallback={<p role="status">관리자 권한을 확인하고 있습니다…</p>}><Admin /></Suspense> : <Home />}
  </StrictMode>,
);
