import { NavLink } from "react-router-dom";
import { useApp } from "../context/AppContext.jsx";

function shortenAddr(addr) {
  if (!addr || addr.length < 24) return addr ?? "";
  return `${addr.slice(0, 10)}…${addr.slice(-6)}`;
}

function getUserLabel(user) {
  return user.ensName ?? user.displayName ?? shortenAddr(user.walletAddress);
}

export default function MainNav() {
  const { currentUser, token, handleLogout, loading } = useApp();

  return (
    <header className="main-nav">
      <div className="main-nav-brand">
        <NavLink className="main-nav-logo" end to="/" aria-label="Bit Lazarus home">
          <span className="nav-wordmark">
            Bit<b>Lazarus</b>
          </span>
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
              {getUserLabel(currentUser)}
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
