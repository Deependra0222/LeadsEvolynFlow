export async function logoutAdmin({ api, setAdminMode, notify }) {
  try {
    await api.logout();
    setAdminMode(false);
    notify("Logged out");
  } catch (error) {
    notify("Logout failed — please try again");
    throw error;
  }
}
