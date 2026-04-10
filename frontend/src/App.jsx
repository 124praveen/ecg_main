import { Routes, Route } from "react-router-dom";
import Navbar from "./components/Navbar.jsx";
import Home from "./pages/Home.jsx";
import Graph from "./pages/Graph.jsx";
import StripTool from "./pages/StripTool.jsx";
import LiveMonitor from "./pages/LiveMonitor.jsx";
import "./App.css";

function App() {
  return (
    <>
      <Navbar />
      {/* Offset content for fixed navbar */}
      <div className="app-content">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/graph" element={<Graph />} />
          <Route path="/strip" element={<StripTool />} />
          <Route path="/live" element={<LiveMonitor />} />
        </Routes>
      </div>
    </>
  );
}

export default App;