import { Outlet } from "react-router-dom";
import { useApp } from "../context/AppContext.jsx";
import MainNav from "./MainNav.jsx";

export default function MainLayout() {
  const { statusMessage } = useApp();

  return (
    <div className="page-shell">
      <div className="layout-stack layout-stack-no-hero">
        <MainNav />
        <div className="status-ribbon layout-status">
          <span className="status-dot" />
          <p>{statusMessage}</p>
        </div>
        <Outlet />
      </div>
    </div>
  );
}
