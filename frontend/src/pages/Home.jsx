import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { FaUpload } from "react-icons/fa";

function Home() {
  const [selectedFiles, setSelectedFiles] = useState([]);
  const navigate = useNavigate();

  const handleFileChange = (e) => {
    const files = Array.from(e.target.files || []);
    setSelectedFiles(files);
  };

  const handlePlotClick = () => {
    if (!selectedFiles.length) return;
    // Navigate to graph page, passing file info via state (you can replace later)
    navigate("/graph", {
      state: {
        files: selectedFiles,
      },
    });
  };

  return (
    <div className="container home-page">
      <div className="row align-items-center gy-5">
        {/* Left: Text + Controls */}
        <div className="col-lg-6">
          <div className="hero-card shadow-sm">
            <h1 className="display-6 mb-3">
              <span className="accent-text">
                Visualize ECG like never before.
              </span>
            </h1>
            <p className="mb-4" style={{ color: "#9ca3af" }}>
              Upload one or more ECG data files and view them on an interactive,
              D3-powered graph. Clean, minimal, and built for clinical clarity.
            </p>

            <div className="mb-3">
              <label
                className="form-label fw-semibold"
                style={{ color: "#9ca3af" }}
              >
                Select ECG File(s)
              </label>
              <div className="file-drop border rounded-4 p-4 d-flex flex-column align-items-center justify-content-center">
                <FaUpload className="upload-icon mb-2" />
                <p className="mb-2 small" style={{ color: "#9ca3af" }}>
                  Drag & drop or click to select files
                </p>
                <input
                  type="file"
                  accept=".txt,.csv,.edf"
                  className="file-input"
                  onChange={handleFileChange}
                />
                <button
                  type="button"
                  className="btn btn-outline-light btn-sm mt-2"
                  onClick={() => document.querySelector(".file-input")?.click()}
                >
                  Choose Files
                </button>
              </div>
            </div>

            {selectedFiles.length > 0 && (
              <div className="selected-files mb-3">
                <div className="d-flex justify-content-between mb-2">
                  <span className="fw-semibold small">
                    Selected Files ({selectedFiles.length})
                  </span>
                </div>
                <ul className="list-group small">
                  {selectedFiles.map((file, idx) => (
                    <li
                      key={idx}
                      className="list-group-item d-flex justify-content-between align-items-center"
                    >
                      <span className="text-truncate me-2">{file.name}</span>
                      <span className="text-muted ms-2">
                        {(file.size / 1024).toFixed(1)} KB
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <button
              type="button"
              className="btn btn-primary btn-lg w-100 mt-2"
              disabled={!selectedFiles.length}
              onClick={handlePlotClick}
            >
              Plot ECG
            </button>

            {/* <p className="hint-text small mt-2" style={{ color: "#9ca3af" }}>
              You&apos;ll be taken to the graph page, where your ECG data will
              be visualized using D3 (logic to be added).
            </p> */}
          </div>
        </div>

        {/* Right: Animated ECG / Graph visual */}
        <div className="col-lg-6">
          <div className="hero-visual">
            <div className="glass-card">
              <div className="ecg-grid"></div>
              <svg
                className="ecg-wave"
                viewBox="0 0 100 40"
                preserveAspectRatio="none"
              >
                {/* Simple ECG-like path, animated via CSS */}
                <polyline
                  points="0,20 10,20 15,10 20,30 25,5 30,35 35,20 45,20 55,20 60,10 65,30 70,8 75,32 80,20 90,20 100,20"
                  className="ecg-wave-path"
                />
              </svg>
              <div className="floating-chip">Live ECG Preview</div>
              <div className="floating-chip chip-secondary">
                Precise Cardiac Waveforms
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Home;
