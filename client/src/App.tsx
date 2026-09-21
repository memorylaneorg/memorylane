import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useEffect, useState } from "react";
import { api } from "./api/client";
import { useAuth } from "./hooks/useAuth";
import Layout from "./components/Layout";
import SetupPage from "./pages/SetupPage";
import LoginPage from "./pages/LoginPage";
import HomePage from "./pages/HomePage";
import FolderPage from "./pages/FolderPage";
import ApplePhotosPage from "./pages/ApplePhotosPage";
import SearchPage from "./pages/SearchPage";
import SettingsPage from "./pages/SettingsPage";
import SurprisePage from "./pages/SurprisePage";
import FavoritesPage from "./pages/FavoritesPage";
import ReportsPage from "./pages/ReportsPage";
import GearMuseumPage from "./pages/GearMuseumPage";
import GearTimelinePage from "./pages/GearTimelinePage";
import SimilarPage from "./pages/SimilarPage";
import PeoplePage from "./pages/PeoplePage";
import PersonPage from "./pages/PersonPage";
import CleanupPage from "./pages/CleanupPage";
import TagsPage from "./pages/TagsPage";
import PluginWelcomePage from "./pages/PluginWelcomePage";
import WelcomePage from "./pages/WelcomePage";
const LocationsPage = lazy(() => import("./pages/LocationsPage"));

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, needsSetup, loading } = useAuth();
  if (loading) return null;
  if (needsSetup) return <Navigate to="/setup" replace />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function OnboardingGate({children}:{children:React.ReactNode}){const[complete,setComplete]=useState<boolean|null>(null);useEffect(()=>{void api.pluginPlatform.onboarding().then(x=>setComplete(x.complete)).catch(()=>setComplete(true));},[]);if(complete===null)return null;if(!complete)return <Navigate to="/welcome" replace/>;return <>{children}</>;}

export default function App() {
  const { needsSetup, loading } = useAuth();

  if (loading) return null;

  return (
    <Routes>
      <Route path="/setup" element={needsSetup ? <SetupPage /> : <Navigate to="/login" replace />} />
      <Route path="/login" element={needsSetup ? <Navigate to="/setup" replace /> : <LoginPage />} />
      <Route path="/welcome" element={<ProtectedRoute><WelcomePage /></ProtectedRoute>} />
      <Route path="/welcome/plugins" element={<ProtectedRoute><PluginWelcomePage /></ProtectedRoute>} />
      <Route
        element={
          <ProtectedRoute>
            <OnboardingGate><Layout /></OnboardingGate>
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<HomePage />} />
        <Route path="/folder/:id" element={<FolderPage />} />
        <Route path="/apple-photos/:id" element={<ApplePhotosPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/surprise" element={<SurprisePage />} />
        <Route path="/favorites" element={<FavoritesPage />} />
        <Route path="/cleanup" element={<CleanupPage />} />
        <Route path="/tags" element={<TagsPage />} />
        <Route path="/locations" element={<Suspense fallback={<p className="text-sm text-muted">Loading map…</p>}><LocationsPage /></Suspense>} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/gear-museum" element={<GearMuseumPage />} />
        <Route path="/gear-timeline" element={<GearTimelinePage />} />
        <Route path="/similar/:id" element={<SimilarPage />} />
        <Route path="/people" element={<PeoplePage />} />
        <Route path="/people/:id" element={<PersonPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
