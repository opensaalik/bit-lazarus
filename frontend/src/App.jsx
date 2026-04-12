import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppProvider } from "./context/AppContext.jsx";
import MainLayout from "./components/MainLayout.jsx";
import HomePage from "./pages/HomePage.jsx";
import MarketplacePage from "./pages/MarketplacePage.jsx";
import CreateBountyPage from "./pages/CreateBountyPage.jsx";
import BountyDetailPage from "./pages/BountyDetailPage.jsx";
import ActivityPage from "./pages/ActivityPage.jsx";

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <AppProvider>
        <Routes>
          <Route path="/" element={<MainLayout />}>
            <Route index element={<HomePage />} />
            <Route path="marketplace" element={<MarketplacePage />} />
            <Route path="bounties/new" element={<CreateBountyPage />} />
            <Route path="bounties/:bountyId" element={<BountyDetailPage />} />
            <Route path="activity" element={<ActivityPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </AppProvider>
    </BrowserRouter>
  );
}
