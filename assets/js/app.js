const app = document.querySelector("#app");
const config = window.APP_CONFIG ?? {};
const views = {
  dashboard: "Dashboard",
  tasks: "My Tasks",
  leaderboard: "Leaderboard",
  notifications: "Notifications",
  profile: "Profile",
  admin: "Admin Dashboard",
  manage: "Manage Tasks",
  users: "Manage Users",
  approvals: "Task Approvals",
  reports: "Reports",
};

let client;
let profile;
let currentView = "dashboard";
let authMode = "login";
let authMessage = "";
let leaderboardPeriod = "today";
let focusTaskId = null;
let dashboardInterval;
let realtimeChannel;

const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);
const icon = (name, className = "") => `<i data-lucide="${name}"${className ? ` class="${className}"` : ""}></i>`;
const initials = (name = "") => name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] ?? "").join("").toUpperCase() || "U";
const dateLabel = (value) => value ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(value)) : "No due date";
const relativeDate = (value) => value ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value)) : "";
const statusClass = (status = "") => status.toLowerCase().replaceAll(" ", "-");

function renderSetup() {
  app.innerHTML = `
    <main class="setup-screen">
      <section class="setup-panel" aria-labelledby="setup-title">
        <span class="brand-mark" aria-hidden="true">T</span>
        <h1 id="setup-title">Connect your workspace</h1>
        <p>Team Tasks is ready for its Supabase project. Add your project URL and public anon key to the local configuration to enable sign-in.</p>
        <code>assets/js/config.js</code>
      </section>
    </main>`;
}

function refreshIcons() {
  window.lucide?.createIcons();
}

function showToast(message, type = "") {
  const region = document.querySelector("#toast-region");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  region.append(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

function renderAuth() {
  const isSignup = authMode === "signup";
  app.innerHTML = `
    <main class="auth-layout">
      <section class="auth-aside">
        <span class="brand-mark" aria-hidden="true">T</span>
        <div><h1>Good work, made visible.</h1><p>A focused home for team priorities, approvals, and the wins that move everyone forward.</p></div>
        <small>TEAM TASKS / INTERNAL WORKSPACE</small>
      </section>
      <section class="auth-form-wrap">
        <form class="auth-form" data-form="auth">
          <h2>${isSignup ? "Create your account" : "Welcome back"}</h2>
          <p>${isSignup ? "Join your team workspace." : "Sign in to pick up where your team left off."}</p>
          ${isSignup ? `<div class="field"><label for="auth-name">Full name</label><input id="auth-name" name="full_name" autocomplete="name" required maxlength="100"></div>` : ""}
          <div class="field"><label for="auth-email">Work email</label><input id="auth-email" name="email" type="email" autocomplete="email" required maxlength="254"></div>
          <div class="field"><label for="auth-password">Password</label><input id="auth-password" name="password" type="password" autocomplete="${isSignup ? "new-password" : "current-password"}" minlength="8" required></div>
          <div class="auth-error" role="alert">${escapeHtml(authMessage)}</div>
          <button class="button-primary full-width" type="submit">${isSignup ? "Create account" : "Sign in"}</button>
          <p style="margin:18px 0 0">${isSignup ? "Already have an account?" : "New to the workspace?"} <button class="text-button" type="button" data-action="toggle-auth">${isSignup ? "Sign in" : "Create an account"}</button></p>
        </form>
      </section>
    </main>`;
  refreshIcons();
}

function renderWorkspace() {
  const admin = profile.role === "admin";
  const generalItems = [
    ["dashboard", "layout-dashboard"], ["tasks", "list-checks"], ["leaderboard", "trophy"],
    ["notifications", "bell"], ["profile", "user-round"],
  ];
  const adminItems = [["admin", "chart-no-axes-column-increasing"], ["manage", "clipboard-list"], ["users", "users-round"], ["approvals", "badge-check"], ["reports", "chart-column"]];
  const nav = (items) => items.map(([view, symbol]) => `
    <button class="nav-item ${currentView === view ? "active" : ""}" data-view="${view}" type="button">${icon(symbol)}<span>${views[view]}</span></button>`).join("");
  const avatar = profile.avatar_url
    ? `<img class="avatar" src="${escapeHtml(profile.avatar_url)}" alt="">`
    : `<span class="avatar" aria-hidden="true">${escapeHtml(initials(profile.full_name))}</span>`;

  app.innerHTML = `
    <div class="workspace">
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-brand"><span class="brand-mark" aria-hidden="true">T</span><span>Team Tasks</span></div>
        <div class="nav-label">Workspace</div><nav class="nav-list" aria-label="Workspace">${nav(generalItems)}</nav>
        ${admin ? `<div class="nav-label">Administration</div><nav class="nav-list" aria-label="Administration">${nav(adminItems)}</nav>` : ""}
        <div class="nav-spacer"></div>
        <div class="user-chip">${avatar}<div class="user-meta"><strong>${escapeHtml(profile.full_name || profile.email)}</strong><span>${admin ? "Administrator" : "Team member"}</span></div><button class="icon-button" type="button" data-action="sign-out" aria-label="Sign out" title="Sign out">${icon("log-out")}</button></div>
      </aside>
      <section class="main-column">
        <header class="topbar">
          <div style="display:flex;align-items:center;gap:12px"><button class="icon-button mobile-menu" type="button" data-action="toggle-sidebar" aria-label="Open navigation">${icon("menu")}</button><span class="breadcrumb">Workspace <span aria-hidden="true">/</span> ${views[currentView]}</span></div>
          <div class="top-actions">
            <div style="position:relative"><button class="icon-button" id="notification-trigger" type="button" data-action="toggle-notifications" aria-label="Notifications" title="Notifications">${icon("bell")}<span class="unread-count" id="unread-dot" hidden></span></button><div class="notification-menu" id="notification-menu" hidden></div></div>
            <button class="icon-button" type="button" data-action="refresh" aria-label="Refresh" title="Refresh">${icon("refresh-cw")}</button>
          </div>
        </header>
        <main class="page-content" id="page-content"><div class="empty-state">Loading workspace…</div></main>
        <div id="dialog-root"></div>
      </section>
    </div>`;
  refreshIcons();
  refreshUnread();
  loadView();
}

async function loadProfile() {
  const { data, error } = await client.from("profiles")
    .select("id,full_name,email,avatar_url,role,is_active").eq("id", (await client.auth.getUser()).data.user.id).single();
  if (error) throw error;
  if (!data.is_active) {
    await client.auth.signOut();
    throw new Error("This account is inactive. Contact an administrator.");
  }
  profile = data;
  const requestedView = window.location.hash.slice(1);
  if (views[requestedView]) currentView = requestedView;
  startRealtime();
  renderWorkspace();
}

async function boot() {
  const { data, error } = await client.auth.getSession();
  if (error) {
    authMessage = error.message;
    renderAuth();
    return;
  }
  if (!data.session) {
    renderAuth();
    return;
  }
  try {
    await loadProfile();
  } catch (error) {
    authMessage = error.message;
    renderAuth();
  }
}

function getUtcPeriod(period) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === "week") {
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  } else if (period === "month") {
    start.setUTCDate(1);
  }
  const end = new Date(start);
  if (period === "today") end.setUTCDate(end.getUTCDate() + 1);
  if (period === "week") end.setUTCDate(end.getUTCDate() + 7);
  if (period === "month") end.setUTCMonth(end.getUTCMonth() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function getLeaderboard(period = "month") {
  const { start, end } = getUtcPeriod(period);
  const { data, error } = await client.rpc("leaderboard_scores", { p_period_start: start, p_period_end: end });
  if (error) throw error;
  return data ?? [];
}

function kpi(label, value, note = "") {
  return `<div class="kpi"><div class="kpi-label">${escapeHtml(label)}</div><div class="kpi-value">${escapeHtml(value)}</div>${note ? `<div class="kpi-note">${escapeHtml(note)}</div>` : ""}</div>`;
}

function statusPill(status) {
  return `<span class="status-pill ${statusClass(status)}">${escapeHtml(status)}</span>`;
}

function taskRow(assignment, canUpdate = true) {
  const task = assignment.tasks ?? {};
  let action = "";
  if (canUpdate && assignment.status === "Pending") action = `<button class="button-secondary" data-action="set-status" data-id="${assignment.id}" data-status="In Progress" type="button">Start</button>`;
  if (canUpdate && ["In Progress", "Rejected"].includes(assignment.status)) action = `<button class="button-primary" data-action="set-status" data-id="${assignment.id}" data-status="Submitted" type="button">${assignment.status === "Rejected" ? "Resubmit" : "Submit"}</button>`;
  return `<div class="task-row ${focusTaskId === assignment.task_id ? "focused" : ""}"><div class="task-main"><strong>${escapeHtml(task.title || "Untitled task")}</strong><span>${escapeHtml(task.task_type === "public" ? "Team task" : "Personal task")} · Due ${escapeHtml(dateLabel(task.due_date))}${assignment.rejection_reason ? ` · ${escapeHtml(assignment.rejection_reason)}` : ""}</span></div><span class="priority-pill ${escapeHtml(task.priority || "low")}">${escapeHtml(task.priority || "low")}</span>${statusPill(assignment.status)}<button class="icon-button" data-action="view-task" data-id="${assignment.task_id}" aria-label="View task details" title="View task details">${icon("info")}</button>${action}</div>`;
}

async function fetchAssignments() {
  const { data, error } = await client.from("task_assignments")
    .select("id,user_id,task_id,status,submitted_at,completed_at,reviewed_at,rejection_reason,created_at,tasks!task_assignments_task_id_fkey(id,title,description,task_type,priority,due_date,created_at)")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

function setContent(html) {
  document.querySelector("#page-content").innerHTML = html;
  refreshIcons();
}

async function renderUserDashboard() {
  const assignments = await fetchAssignments();
  const completed = assignments.filter((item) => item.status === "Completed").length;
  const pending = assignments.filter((item) => !["Completed", "Rejected"].includes(item.status)).length;
  const rejected = assignments.filter((item) => item.status === "Rejected").length;
  const board = await getLeaderboard("month");
  const ownScore = board.find((row) => row.user_id === profile.id);
  const rank = board.findIndex((row) => row.user_id === profile.id) + 1;
  const dueSoon = assignments.filter((item) => item.tasks?.due_date && new Date(item.tasks.due_date) >= new Date() && item.status !== "Completed")
    .sort((a, b) => new Date(a.tasks.due_date) - new Date(b.tasks.due_date)).slice(0, 4);
  const recent = assignments.slice(0, 4);
  setContent(`
    <div class="page-heading"><div><h1>Good ${new Date().getUTCHours() < 12 ? "morning" : "afternoon"}, ${escapeHtml((profile.full_name || "there").split(" ")[0])}.</h1><p>Your team's next steps, all in one place.</p></div></div>
    <section class="kpi-grid">${kpi("Stars this month", ownScore?.stars ?? 0, "UTC calendar month")}${kpi("Completed tasks", completed)}${kpi("Pending tasks", pending)}${kpi("Rejected tasks", rejected)}${kpi("Leaderboard position", rank || "—")}</section>
    <section class="content-grid"><div class="panel"><div class="panel-header"><h2>Recent tasks</h2><button class="text-button" data-view="tasks" type="button">View all</button></div><div class="panel-body task-list">${recent.length ? recent.map((item) => taskRow(item)).join("") : `<div class="empty-state">Nothing assigned yet. New tasks will appear here.</div>`}</div></div>
    <div class="panel"><div class="panel-header"><h2>Upcoming deadlines</h2></div><div class="panel-body">${dueSoon.length ? dueSoon.map((item) => `<div class="activity-row"><span class="avatar">${icon("calendar-days")}</span><div class="task-main"><strong>${escapeHtml(item.tasks.title)}</strong><span>Due ${escapeHtml(dateLabel(item.tasks.due_date))}</span></div></div>`).join("") : `<div class="empty-state">No upcoming deadlines.</div>`}</div></div></section>
    <section class="panel" style="margin-top:16px"><div class="panel-header"><h2>Leaderboard this month</h2><button class="text-button" data-view="leaderboard" type="button">Open leaderboard</button></div><div class="panel-body">${renderLeaderRows(board.slice(0, 5))}</div></section>`);
}

function renderLeaderRows(rows) {
  if (!rows.length) return `<div class="empty-state">No scores for this period yet.</div>`;
  return rows.map((row, index) => {
    const rankClass = ["gold", "silver", "bronze"][index] || "";
    const userAvatar = row.avatar_url
      ? `<img class="avatar" src="${escapeHtml(row.avatar_url)}" alt="">`
      : `<span class="avatar" aria-hidden="true">${escapeHtml(initials(row.full_name))}</span>`;
    return `<div class="leader-row"><span class="rank ${rankClass}">${index + 1}</span>${userAvatar}<span class="leader-name">${escapeHtml(row.full_name || "Team member")}</span><span class="leader-score">${row.stars} ★ <span style="color:var(--muted);font-weight:500">· ${row.approved_tasks} approved</span></span></div>`;
  }).join("");
}

async function renderTasks() {
  const assignments = await fetchAssignments();
  const selected = assignments.find((item) => item.task_id === focusTaskId);
  const detail = selected ? `<section class="panel" style="margin-bottom:16px"><div class="panel-header"><h2>${escapeHtml(selected.tasks?.title || "Task details")}</h2>${statusPill(selected.status)}</div><div class="panel-body"><p>${escapeHtml(selected.tasks?.description || "No description provided.")}</p><p class="kpi-note">${escapeHtml(selected.tasks?.task_type === "public" ? "Public task" : "Personal task")} · ${escapeHtml(selected.tasks?.priority || "low")} priority · Due ${escapeHtml(dateLabel(selected.tasks?.due_date))}</p></div></section>` : "";
  focusTaskId = null;
  setContent(`<div class="page-heading"><div><h1>My Tasks</h1><p>Tasks assigned to you by your team.</p></div></div>${detail}<section class="panel"><div class="panel-header"><h2>${assignments.length} assigned</h2></div><div class="panel-body task-list">${assignments.length ? assignments.map((item) => taskRow(item)).join("") : `<div class="empty-state">No tasks assigned to you yet.</div>`}</div></section>`);
}

async function renderLeaderboard() {
  const rows = await getLeaderboard(leaderboardPeriod);
  setContent(`<div class="page-heading"><div><h1>Leaderboard</h1><p>Approved tasks earn one star. Scores use UTC calendar periods.</p></div></div><section class="panel"><div class="leaderboard-tabs" role="tablist" aria-label="Leaderboard period">${[["today", "TOP TODAY"], ["week", "TOP THIS WEEK"], ["month", "TOP THIS MONTH"]].map(([key, label]) => `<button class="tab-button ${leaderboardPeriod === key ? "active" : ""}" data-period="${key}" type="button" role="tab" aria-selected="${leaderboardPeriod === key}">${label}</button>`).join("")}</div><div class="panel-body">${renderLeaderRows(rows)}</div></section>`);
}

async function getNotifications(limit = 100) {
  const { data, error } = await client.from("notifications").select("id,title,message,type,related_task_id,is_read,created_at")
    .order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return data ?? [];
}

function notificationRows(rows) {
  if (!rows.length) return `<div class="empty-state">You're all caught up.</div>`;
  return rows.map((row) => `<div class="notification-row ${row.is_read ? "" : "unread"}" role="button" tabindex="0" data-action="open-notification" data-id="${row.id}" data-task="${row.related_task_id ?? ""}"><div class="notification-copy"><strong>${escapeHtml(row.title)}</strong><span>${escapeHtml(row.message)}</span><time>${escapeHtml(relativeDate(row.created_at))}</time></div>${row.is_read ? "" : `<span class="unread-dot" aria-label="Unread"></span>`}</div>`).join("");
}

async function renderNotifications() {
  const rows = await getNotifications();
  setContent(`<div class="page-heading"><div><h1>Notifications</h1><p>Task assignments and review updates.</p></div><button class="button-secondary" data-action="mark-all-read" type="button">Mark all read</button></div><section class="panel"><div class="panel-body notification-list">${notificationRows(rows)}</div></section>`);
}

async function renderProfile() {
  setContent(`<div class="page-heading"><div><h1>Profile</h1><p>Manage the details shown to your team.</p></div></div><section class="panel"><div class="panel-body"><form data-form="profile"><div class="field"><label for="profile-name">Full name</label><input id="profile-name" name="full_name" value="${escapeHtml(profile.full_name)}" required maxlength="100"></div><div class="field"><label for="profile-avatar">Avatar URL</label><input id="profile-avatar" name="avatar_url" type="url" value="${escapeHtml(profile.avatar_url || "")}" maxlength="1000"></div><div class="field"><label>Email</label><input value="${escapeHtml(profile.email)}" disabled></div><button class="button-primary" type="submit">Save profile</button></form></div></section>`);
}

async function renderAdminDashboard() {
  const { data, error } = await client.rpc("admin_dashboard_stats");
  if (error) throw error;
  const stats = data ?? {};
  const assignments = await client.from("task_assignments").select("id,user_id,status,created_at,tasks!task_assignments_task_id_fkey(title),profiles!task_assignments_user_id_fkey(full_name)").order("created_at", { ascending: false }).limit(6);
  if (assignments.error) throw assignments.error;
  setContent(`<div class="page-heading"><div><h1>Admin Dashboard</h1><p>Team activity and task health at a glance.</p></div><button class="button-primary" data-action="open-create-task" type="button">${icon("plus")} New task</button></div>
    <section class="kpi-grid">${kpi("Total users", stats.total_users ?? 0, `${stats.active_users ?? 0} active`)}${kpi("Total tasks", stats.total_tasks ?? 0)}${kpi("Completed tasks", stats.completed_tasks ?? 0)}${kpi("Pending approvals", stats.pending_approvals ?? 0)}${kpi("Tasks this month", stats.tasks_created_this_month ?? 0)}${kpi("Stars this month", stats.stars_this_month ?? 0)}</section>
    <section class="content-grid"><div class="panel"><div class="panel-header"><h2>Recent task activity</h2><button class="text-button" data-view="approvals" type="button">Review submissions</button></div><div class="panel-body task-list">${assignments.data.length ? assignments.data.map((item) => `<div class="task-row"><div class="task-main"><strong>${escapeHtml(item.tasks?.title || "Task")}</strong><span>${escapeHtml(item.profiles?.full_name || "Team member")} · Updated ${escapeHtml(relativeDate(item.created_at))}</span></div>${statusPill(item.status)}</div>`).join("") : `<div class="empty-state">No activity yet.</div>`}</div></div>
    <div class="panel"><div class="panel-header"><h2>Quick links</h2></div><div class="panel-body" style="display:grid;gap:8px"><button class="button-secondary" data-view="manage" type="button">Manage tasks</button><button class="button-secondary" data-view="users" type="button">Manage users</button><button class="button-secondary" data-view="approvals" type="button">Review submissions</button></div></div></section>`);
}

async function renderManageTasks() {
  const { data: tasks, error } = await client.from("tasks").select("id,title,task_type,priority,status,due_date,created_at")
    .order("created_at", { ascending: false });
  if (error) throw error;
  const { data: assignments, error: assignmentError } = await client.from("task_assignments").select("task_id,status");
  if (assignmentError) throw assignmentError;
  const counts = (assignments ?? []).reduce((result, item) => {
    result[item.task_id] ??= { total: 0, done: 0 };
    result[item.task_id].total++;
    if (item.status === "Completed") result[item.task_id].done++;
    return result;
  }, {});
  setContent(`<div class="page-heading"><div><h1>Manage Tasks</h1><p>Create, track, and remove team assignments.</p></div><button class="button-primary" data-action="open-create-task" type="button">${icon("plus")} New task</button></div><section class="panel"><div class="table-wrap"><table><thead><tr><th>Task</th><th>Type</th><th>Priority</th><th>Status</th><th>Progress</th><th>Due</th><th></th></tr></thead><tbody>${tasks.length ? tasks.map((task) => `<tr><td><strong>${escapeHtml(task.title)}</strong></td><td>${task.task_type === "public" ? "Public" : "Personal"}</td><td><span class="priority-pill ${escapeHtml(task.priority)}">${escapeHtml(task.priority)}</span></td><td>${statusPill(task.status)}</td><td>${counts[task.id]?.done ?? 0} / ${counts[task.id]?.total ?? 0}</td><td>${escapeHtml(dateLabel(task.due_date))}</td><td><div class="row-actions"><button class="icon-button" data-action="edit-task" data-id="${task.id}" aria-label="Edit task" title="Edit task">${icon("pencil")}</button><button class="icon-button" data-action="retry-email" data-id="${task.id}" aria-label="Retry failed task emails" title="Retry failed task emails">${icon("mail")}</button><button class="icon-button" data-action="delete-task" data-id="${task.id}" aria-label="Delete task" title="Delete task">${icon("trash-2")}</button></div></td></tr>`).join("") : `<tr><td colspan="7" class="empty-state">No tasks created yet.</td></tr>`}</tbody></table></div></section>`);
}

async function renderUsers() {
  const { data, error } = await client.from("profiles").select("id,full_name,email,role,is_active,created_at").order("created_at", { ascending: false });
  if (error) throw error;
  setContent(`<div class="page-heading"><div><h1>Manage Users</h1><p>Account roles are assigned through the secure Supabase admin setup.</p></div></div><section class="panel"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Joined</th><th>Status</th><th></th></tr></thead><tbody>${data.length ? data.map((person) => `<tr><td>${escapeHtml(person.full_name || "Unnamed user")}</td><td>${escapeHtml(person.email)}</td><td>${escapeHtml(person.role)}</td><td>${escapeHtml(dateLabel(person.created_at))}</td><td>${person.is_active ? "Active" : "Inactive"}</td><td>${person.role === "user" ? `<button class="button-secondary" data-action="toggle-user" data-id="${person.id}" data-active="${person.is_active}">${person.is_active ? "Deactivate" : "Activate"}</button>` : ""}</td></tr>`).join("") : `<tr><td colspan="6" class="empty-state">No users found.</td></tr>`}</tbody></table></div></section>`);
}

async function renderApprovals() {
  const { data, error } = await client.from("task_assignments")
    .select("id,user_id,status,submitted_at,tasks!task_assignments_task_id_fkey(title,description),profiles!task_assignments_user_id_fkey(full_name,email)")
    .eq("status", "Submitted").order("submitted_at", { ascending: true });
  if (error) throw error;
  setContent(`<div class="page-heading"><div><h1>Task Approvals</h1><p>Review submitted work and award stars for approved tasks.</p></div></div><section class="panel"><div class="table-wrap"><table><thead><tr><th>Task</th><th>Submitted by</th><th>Submitted</th><th>Description</th><th></th></tr></thead><tbody>${data.length ? data.map((row) => `<tr><td><strong>${escapeHtml(row.tasks?.title)}</strong></td><td>${escapeHtml(row.profiles?.full_name || row.profiles?.email || "User")}</td><td>${escapeHtml(relativeDate(row.submitted_at))}</td><td>${escapeHtml((row.tasks?.description || "").slice(0, 100))}</td><td><div class="row-actions"><button class="button-primary" data-action="review-approve" data-id="${row.id}" type="button">Approve · 1 ★</button><button class="button-secondary" data-action="review-reject" data-id="${row.id}" type="button">Reject</button></div></td></tr>`).join("") : `<tr><td colspan="5" class="empty-state">No submissions need review.</td></tr>`}</tbody></table></div></section>`);
}

async function renderReports() {
  const rows = await getLeaderboard("month");
  setContent(`<div class="page-heading"><div><h1>Reports</h1><p>Monthly approved-task totals, ranked with deterministic tie breaks.</p></div></div><section class="panel"><div class="table-wrap"><table><thead><tr><th>Rank</th><th>Team member</th><th>Approved tasks</th><th>Stars this month</th></tr></thead><tbody>${rows.length ? rows.map((row, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(row.full_name || "Team member")}</td><td>${row.approved_tasks}</td><td class="star-total">${row.stars} ★</td></tr>`).join("") : `<tr><td colspan="4" class="empty-state">No report data yet.</td></tr>`}</tbody></table></div></section>`);
}

function showViewError(error) {
  setContent(`<section class="panel"><div class="empty-state" role="alert">${escapeHtml(error.message || "Unable to load this view.")}<br><button class="button-secondary" data-action="refresh" type="button" style="margin-top:12px">Try again</button></div></section>`);
}

async function loadView() {
  if (!profile) return;
  clearInterval(dashboardInterval);
  const allowedAdmin = ["admin", "manage", "users", "approvals", "reports"].includes(currentView);
  if (allowedAdmin && profile.role !== "admin") currentView = "dashboard";
  try {
    if (currentView === "dashboard") profile.role === "admin" ? await renderAdminDashboard() : await renderUserDashboard();
    else if (currentView === "tasks") await renderTasks();
    else if (currentView === "leaderboard") await renderLeaderboard();
    else if (currentView === "notifications") await renderNotifications();
    else if (currentView === "profile") await renderProfile();
    else if (currentView === "admin") await renderAdminDashboard();
    else if (currentView === "manage") await renderManageTasks();
    else if (currentView === "users") await renderUsers();
    else if (currentView === "approvals") await renderApprovals();
    else if (currentView === "reports") await renderReports();
    if (currentView === "dashboard" || currentView === "leaderboard") {
      dashboardInterval = window.setInterval(() => {
        if (currentView === "dashboard" || currentView === "leaderboard") loadView();
      }, 30000);
    }
  } catch (error) {
    showViewError(error);
  }
}

function navigate(view) {
  if (!views[view] || (["admin", "manage", "users", "approvals", "reports"].includes(view) && profile.role !== "admin")) return;
  currentView = view;
  window.history.replaceState(null, "", `#${view}`);
  renderWorkspace();
  if (window.innerWidth <= 680) document.querySelector("#sidebar")?.classList.remove("open");
}

async function refreshUnread() {
  if (!profile || !client) return;
  const { count, error } = await client.from("notifications").select("id", { count: "exact", head: true }).eq("is_read", false);
  if (!error) {
    const dot = document.querySelector("#unread-dot");
    if (dot) {
      dot.hidden = !count;
      dot.textContent = count > 9 ? "9+" : String(count ?? 0);
    }
  }
}

function startRealtime() {
  if (realtimeChannel) client.removeChannel(realtimeChannel);
  realtimeChannel = client.channel(`team-tasks-${profile.id}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${profile.id}` }, () => {
      refreshUnread();
      if (currentView === "notifications") loadView();
    })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "star_transactions", filter: `user_id=eq.${profile.id}` }, () => {
      if (currentView === "dashboard" || currentView === "leaderboard" || currentView === "reports") loadView();
    })
    .subscribe();
}

async function openNotificationMenu() {
  const menu = document.querySelector("#notification-menu");
  menu.hidden = !menu.hidden;
  if (menu.hidden) return;
  try {
    const rows = await getNotifications(8);
    menu.innerHTML = `<h3>Notifications</h3>${notificationRows(rows)}<button class="text-button" data-view="notifications" type="button" style="margin:0 16px 12px">View all</button>`;
  } catch (error) {
    menu.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

async function openTaskDialog(taskId = null) {
  let task = null;
  let users = [];
  if (taskId) {
    const result = await client.from("tasks").select("id,title,description,task_type,priority,due_date").eq("id", taskId).single();
    if (result.error) return showToast(result.error.message, "error");
    task = result.data;
  } else {
    const result = await client.from("profiles").select("id,full_name,email,role").eq("is_active", true).order("full_name");
    if (result.error) return showToast(result.error.message, "error");
    users = result.data ?? [];
  }
  const edit = Boolean(task);
  const dueValue = task?.due_date ? new Date(task.due_date).toISOString().slice(0, 10) : "";
  document.querySelector("#dialog-root").innerHTML = `<div class="dialog-backdrop"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="task-dialog-title"><div class="dialog-header"><h2 id="task-dialog-title">${edit ? "Edit task" : "Create a task"}</h2><button class="icon-button" data-action="close-modal" type="button" aria-label="Close">${icon("x")}</button></div><form data-form="create-task" ${edit ? `data-id="${task.id}"` : ""}><div class="field"><label for="task-title">Title</label><input id="task-title" name="title" maxlength="160" required value="${escapeHtml(task?.title || "")}"></div><div class="field"><label for="task-description">Description</label><textarea id="task-description" name="description" maxlength="10000">${escapeHtml(task?.description || "")}</textarea></div><div class="field"><label for="task-type">Assignment type</label><select id="task-type" name="task_type" ${edit ? "disabled" : ""}><option value="public" ${task?.task_type === "public" ? "selected" : ""}>Public · all active users</option><option value="personal" ${task?.task_type === "personal" ? "selected" : ""}>Personal · one user</option></select></div><div class="field" id="assignee-field" hidden><label for="task-assignee">Assigned user</label><select id="task-assignee" name="assigned_user" disabled required><option value="">Select a user</option>${users.map((person) => `<option value="${person.id}">${escapeHtml(person.full_name || person.email)}${person.role === "admin" ? " · Admin" : ""}</option>`).join("")}</select></div><div class="field"><label for="task-priority">Priority</label><select id="task-priority" name="priority"><option value="low" ${task?.priority === "low" ? "selected" : ""}>Low</option><option value="medium" ${!task || task.priority === "medium" ? "selected" : ""}>Medium</option><option value="high" ${task?.priority === "high" ? "selected" : ""}>High</option></select></div><div class="field"><label for="task-due">Due date (optional)</label><input id="task-due" name="due_date" type="date" value="${dueValue}"></div><div class="dialog-footer"><button class="button-secondary" data-action="close-modal" type="button">Cancel</button><button class="button-primary" type="submit">${edit ? "Save changes" : "Create task"}</button></div></form></section></div>`;
  refreshIcons();
  document.querySelector("#task-title")?.focus();
}

async function sendTaskEmail(taskId, emailType) {
  const { data, error } = await client.functions.invoke("send-notification", { body: { task_id: taskId, email_type: emailType } });
  if (error) throw error;
  if (data?.failed) throw new Error(`${data.failed} email${data.failed === 1 ? "" : "s"} failed; use Retry failed task emails to retry.`);
}

async function onClick(event) {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) return navigate(viewButton.dataset.view);
  const periodButton = event.target.closest("[data-period]");
  if (periodButton) {
    leaderboardPeriod = periodButton.dataset.period;
    return renderLeaderboard().catch(showViewError);
  }
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const { action, id } = target.dataset;
  try {
    if (action === "toggle-auth") { authMode = authMode === "login" ? "signup" : "login"; authMessage = ""; renderAuth(); }
    else if (action === "sign-out") { await client.auth.signOut(); profile = null; renderAuth(); }
    else if (action === "refresh") await loadView();
    else if (action === "toggle-sidebar") document.querySelector("#sidebar")?.classList.toggle("open");
    else if (action === "toggle-notifications") await openNotificationMenu();
    else if (action === "open-create-task") await openTaskDialog();
    else if (action === "edit-task") await openTaskDialog(id);
    else if (action === "view-task") {
      currentView = "tasks";
      focusTaskId = id;
      window.history.replaceState(null, "", "#tasks");
      renderWorkspace();
    }
    else if (action === "close-modal") document.querySelector("#dialog-root").innerHTML = "";
    else if (action === "set-status") {
      const { error } = await client.rpc("set_assignment_status", { p_assignment_id: id, p_status: target.dataset.status });
      if (error) throw error;
      showToast(target.dataset.status === "Submitted" ? "Task submitted for approval." : "Task moved to In Progress.");
      await loadView();
    } else if (action === "review-approve") {
      const { data, error } = await client.rpc("review_task", { p_assignment_id: id, p_decision: "approve", p_rejection_reason: null });
      if (error) throw error;
      await sendTaskEmail(data.task_id, "task_approved").catch((mailError) => showToast(`Approved, but email delivery failed: ${mailError.message}`, "error"));
      showToast("Task approved. One star awarded.");
      await loadView();
    } else if (action === "review-reject") {
      document.querySelector("#dialog-root").innerHTML = `<div class="dialog-backdrop"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="reject-title"><div class="dialog-header"><h2 id="reject-title">Request another pass</h2><button class="icon-button" data-action="close-modal" type="button" aria-label="Close">${icon("x")}</button></div><form data-form="reject-task" data-id="${id}"><div class="field"><label for="reject-reason">Reason</label><textarea id="reject-reason" name="reason" maxlength="1000" required></textarea></div><div class="dialog-footer"><button class="button-secondary" data-action="close-modal" type="button">Cancel</button><button class="button-primary" type="submit">Reject submission</button></div></form></section></div>`;
      refreshIcons();
    } else if (action === "delete-task") {
      if (!window.confirm("Delete this task? Tasks with an awarded star are retained for history.")) return;
      const { error } = await client.rpc("delete_task", { p_task_id: id });
      if (error) throw error;
      showToast("Task deleted.");
      await loadView();
    } else if (action === "toggle-user") {
      const { error } = await client.rpc("set_user_active", { p_user_id: id, p_is_active: target.dataset.active !== "true" });
      if (error) throw error;
      showToast(target.dataset.active === "true" ? "User deactivated." : "User activated.");
      await loadView();
    } else if (action === "retry-email") {
      const results = await Promise.allSettled(["new_task", "task_approved", "task_rejected"].map((type) => sendTaskEmail(id, type)));
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length) throw new Error("Some email event types still failed. Already-sent messages were not duplicated.");
      showToast("Failed task emails retried.");
    } else if (action === "mark-all-read") {
      const { error } = await client.rpc("mark_all_notifications_read");
      if (error) throw error;
      showToast("Notifications marked as read.");
      await loadView();
      refreshUnread();
    } else if (action === "open-notification") {
      const row = (await getNotifications()).find((item) => item.id === id);
      if (row && !row.is_read) await client.rpc("mark_notification_read", { p_notification_id: id });
      document.querySelector("#notification-menu")?.setAttribute("hidden", "");
      currentView = "tasks";
      focusTaskId = target.dataset.task || null;
      window.history.replaceState(null, "", "#tasks");
      renderWorkspace();
      refreshUnread();
    }
  } catch (error) {
    showToast(error.message || "The action could not be completed.", "error");
  }
}

async function onSubmit(event) {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  const formData = new FormData(form);
  const values = Object.fromEntries(formData.entries());
  const submitButton = form.querySelector("button[type=submit]");
  if (submitButton) submitButton.disabled = true;
  try {
    if (form.dataset.form === "auth") {
      authMessage = "";
      if (authMode === "signup") {
        const { data, error } = await client.auth.signUp({
          email: values.email.trim(), password: values.password,
          options: { data: { full_name: values.full_name.trim() } },
        });
        if (error) throw error;
        if (!data.session) {
          authMode = "login";
          authMessage = "Account created. Check your email to confirm, then sign in.";
          renderAuth();
          return;
        }
      } else {
        const { error } = await client.auth.signInWithPassword({ email: values.email.trim(), password: values.password });
        if (error) throw error;
      }
      await loadProfile();
    } else if (form.dataset.form === "create-task") {
      const dueDate = values.due_date ? new Date(`${values.due_date}T23:59:59Z`).toISOString() : null;
      if (form.dataset.id) {
        const { error } = await client.rpc("update_task", {
          p_task_id: form.dataset.id, p_title: values.title.trim(), p_description: values.description.trim(),
          p_priority: values.priority, p_due_date: dueDate,
        });
        if (error) throw error;
        document.querySelector("#dialog-root").innerHTML = "";
        showToast("Task updated.");
        await loadView();
        return;
      }
      const { data: taskId, error } = await client.rpc("create_task", {
        p_title: values.title.trim(), p_description: values.description.trim(),
        p_task_type: values.task_type, p_priority: values.priority, p_due_date: dueDate,
        p_assigned_user: values.task_type === "personal" ? values.assigned_user : null,
      });
      if (error) throw error;
      document.querySelector("#dialog-root").innerHTML = "";
      try {
        await sendTaskEmail(taskId, "new_task");
        showToast("Task created. Website and email notifications sent.");
      } catch (error) {
        showToast(`Task created with website notifications. Email delivery issue: ${error.message}`, "error");
      }
      await loadView();
    } else if (form.dataset.form === "reject-task") {
      const { data, error } = await client.rpc("review_task", { p_assignment_id: form.dataset.id, p_decision: "reject", p_rejection_reason: values.reason.trim() });
      if (error) throw error;
      document.querySelector("#dialog-root").innerHTML = "";
      await sendTaskEmail(data.task_id, "task_rejected").catch((mailError) => showToast(`Rejected, but email delivery failed: ${mailError.message}`, "error"));
      showToast("Submission rejected; the user has been notified.");
      await loadView();
    } else if (form.dataset.form === "profile") {
      const { data, error } = await client.from("profiles").update({ full_name: values.full_name.trim(), avatar_url: values.avatar_url.trim() || null })
        .eq("id", profile.id).select("id,full_name,email,avatar_url,role,is_active").single();
      if (error) throw error;
      profile = data;
      showToast("Profile saved.");
      renderWorkspace();
    }
  } catch (error) {
    if (form.dataset.form === "auth") {
      authMessage = error.message || "Sign-in failed.";
      renderAuth();
    } else {
      showToast(error.message || "The request could not be completed.", "error");
      if (submitButton) submitButton.disabled = false;
    }
  }
}

app.addEventListener("click", onClick);
app.addEventListener("submit", onSubmit);
app.addEventListener("change", (event) => {
  if (event.target.id === "task-type") {
    const personal = event.target.value === "personal";
    const field = document.querySelector("#assignee-field");
    const select = document.querySelector("#task-assignee");
    field.hidden = !personal;
    select.disabled = !personal;
    select.required = personal;
  }
  if (event.target.matches("[data-period]")) {
    leaderboardPeriod = event.target.dataset.period;
    renderLeaderboard().catch(showViewError);
  }
});

document.addEventListener("keydown", (event) => {
  const row = event.target.closest?.("[data-action='open-notification']");
  if (row && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    row.click();
  }
});

if (!config.supabaseUrl || !config.supabaseAnonKey || !window.supabase?.createClient) {
  renderSetup();
} else {
  client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  client.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") {
      profile = null;
      if (realtimeChannel) client.removeChannel(realtimeChannel);
      renderAuth();
    }
  });
  boot();
}