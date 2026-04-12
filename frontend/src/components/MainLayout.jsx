import { Suspense, lazy } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { useApp } from "../context/AppContext.jsx";
import MainNav from "./MainNav.jsx";

const HeroScene = lazy(() => import("../HeroScene.jsx"));

export default function MainLayout() {
  const location = useLocation();
  const { statusMessage } = useApp();
  const showHero = location.pathname === "/" || location.pathname === "";

  return (
    <div className="page-shell">
      {showHero ? (
        <Suspense fallback={<div className="hero-scene hero-scene-fallback" />}>
          <HeroScene />
        </Suspense>
      ) : null}

      <div className={`layout-stack${showHero ? "" : " layout-stack-no-hero"}`}>
        <MainNav />

        {showHero ? null : (
          <div className="status-ribbon layout-status">
            <span className="status-dot" />
            <p>{statusMessage}</p>
          </div>
        )}

        <Outlet />
      </div>
    </div>
  );
}
