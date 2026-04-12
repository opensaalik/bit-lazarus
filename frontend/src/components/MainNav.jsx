import { NavLink } from "react-router-dom";
import { useApp } from "../context/AppContext.jsx";

function shortenAddr(addr) {
  if (!addr || addr.length < 24) return addr ?? "";
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}

export default function MainNav() {
  const { currentUser, token, handleLogout, loading } = useApp();

  return (
    <header className="main-nav glass-panel">
      <div className="main-nav-brand">
        <NavLink className="main-nav-logo" end to="/">
          <img
            alt="Bit Lazarus"
            className="main-nav-logo-image"
            src="/bit-lazarus-logo.svg"
          />
        </NavLink>
      </div>
      <nav className="main-nav-links" aria-label="Primary">
        <NavLink className={({ isActive }) => `nav-link${isActive ? " nav-link-active" : ""}`} end to="/">
          Home
        </NavLink>
        <NavLink
          className={({ isActive }) => `nav-link${isActive ? " nav-link-active" : ""}`}
          to="/marketplace"
        >
          Marketplace
        </NavLink>
        <NavLink
          className={({ isActive }) => `nav-link${isActive ? " nav-link-active" : ""}`}
          to="/bounties/new"
        >
          New bounty
        </NavLink>
      </nav>
      <div className="main-nav-session">
        {token && currentUser ? (
          <>
            <span className="nav-wallet-chip" title={currentUser.walletAddress}>
              {currentUser.displayName ?? shortenAddr(currentUser.walletAddress)}
            </span>
            <button className="secondary-button nav-logout" disabled={loading} onClick={handleLogout} type="button">
              Disconnect
            </button>
          </>
        ) : (
          <span className="muted-copy nav-guest">Connect from Home</span>
        )}
      </div>
    </header>
  );
}
