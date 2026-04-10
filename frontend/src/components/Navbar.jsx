import { Link, useLocation } from "react-router-dom";
import { FaHeartbeat } from "react-icons/fa";
import { MdOutlineAnalytics, MdMonitorHeart } from "react-icons/md";

function Navbar() {
  const location = useLocation();

  return (
    <nav className="navbar navbar-expand-lg navbar-dark bg-dark shadow-sm fixed-top">
      <div className="container-fluid px-4">
        <Link className="navbar-brand d-flex align-items-center gap-2" to="/">
          <span className="brand-icon-wrapper">
            <FaHeartbeat className="brand-icon" />
          </span>
          <span className="fw-semibold">ECG Live Studio</span>
        </Link>

        <button
          className="navbar-toggler"
          type="button"
          data-bs-toggle="collapse"
          data-bs-target="#mainNavbar"
        >
          <span className="navbar-toggler-icon"></span>
        </button>

        <div className="collapse navbar-collapse" id="mainNavbar">
          <ul className="navbar-nav ms-auto align-items-lg-center gap-lg-2">
            <li className="nav-item">
              <Link
                className={`nav-link ${location.pathname === "/" ? "active" : ""}`}
                to="/"
              >
                Home
              </Link>
            </li>

            {location.pathname === "/graph" && (
              <li className="nav-item">
                <Link
                  className="nav-link active"
                  to="/graph"
                >
                  ECG Plot
                </Link>
              </li>
            )}

            <li className="nav-item">
              <Link
                className={`nav-link d-flex align-items-center gap-1 ${
                  location.pathname === "/live" ? "active" : ""
                }`}
                to="/live"
              >
                <MdMonitorHeart size={16} />
                Live Monitor
              </Link>
            </li>

            <li className="nav-item">
              <Link
                className={`nav-link d-flex align-items-center gap-1 ${
                  location.pathname === "/strip" ? "active" : ""
                }`}
                to="/strip"
              >
                <MdOutlineAnalytics size={16} />
                Strip Tool
              </Link>
            </li>
          </ul>
        </div>
      </div>
    </nav>
  );
}

export default Navbar;