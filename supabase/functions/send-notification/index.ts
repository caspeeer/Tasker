import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const resendKey = Deno.env.get("RESEND_API_KEY")!;
const sender = Deno.env.get("RESEND_FROM")!;
const appOrigin = Deno.env.get("APP_ORIGIN") ?? "https://example.com";
type EmailType = "new_task" | "task_approved" | "task_rejected";
const emailTypes: EmailType[] = ["new_task", "task_approved", "task_rejected"];

const corsHeaders = {
  "Access-Control-Allow-Origin": appOrigin,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405, headers: corsHeaders });

  try {
    if (!resendKey || !sender || !serviceKey || !anonKey) throw new Error("Email function is not configured");
    const authorization = request.headers.get("Authorization");
    if (!authorization) return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });

    const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
    const { data: { user }, error: authError } = await callerClient.auth.getUser();
    if (authError || !user) return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });

    const adminClient = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const { data: callerProfile, error: profileError } = await adminClient
      .from("profiles").select("role,is_active").eq("id", user.id).single();
    if (profileError || callerProfile.role !== "admin" || !callerProfile.is_active) {
      return Response.json({ error: "Admin access required" }, { status: 403, headers: corsHeaders });
    }

    const body = await request.json();
    const taskId = typeof body.task_id === "string" ? body.task_id : "";
    const emailTypeValue = body?.email_type;
    if (!taskId || typeof emailTypeValue !== "string" || !emailTypes.includes(emailTypeValue as EmailType)) {
      return Response.json({ error: "Invalid request" }, { status: 400, headers: corsHeaders });
    }
    const emailType: EmailType = emailTypeValue as EmailType;

    const { data: task, error: taskError } = await adminClient
      .from("tasks").select("id,title,description,due_date").eq("id", taskId).single();
    if (taskError || !task) return Response.json({ error: "Task not found" }, { status: 404, headers: corsHeaders });

    let assignmentsQuery = adminClient.from("task_assignments")
      .select("id,user_id,status,rejection_reason,profiles!task_assignments_user_id_fkey(email,full_name)")
      .eq("task_id", taskId);
    if (emailType === "task_approved") assignmentsQuery = assignmentsQuery.eq("status", "Completed");
    if (emailType === "task_rejected") assignmentsQuery = assignmentsQuery.eq("status", "Rejected");
    const { data: assignments, error: assignmentsError } = await assignmentsQuery;
    if (assignmentsError) throw assignmentsError;

    const emailSubjects: Record<EmailType, string> = {
      new_task: `New task: ${task.title}`,
      task_approved: `Task approved: ${task.title}`,
      task_rejected: `Task needs another pass: ${task.title}`,
    };
    let sent = 0;
    let failed = 0;

    for (const assignment of assignments ?? []) {
      const profile = Array.isArray(assignment.profiles) ? assignment.profiles[0] : assignment.profiles;
      if (!profile?.email) continue;
      const { data: logId, error: claimError } = await adminClient.rpc("claim_email", {
        p_user_id: assignment.user_id,
        p_task_id: taskId,
        p_email_type: emailType,
      });
      if (claimError) throw claimError;
      if (!logId) continue;

      const name = escapeHtml(profile.full_name || "there");
      const title = escapeHtml(task.title);
      const description = escapeHtml(task.description || "").replace(/\n/g, "<br>");
      const message = emailType === "task_approved"
        ? "Your submission has been approved. One star has been added to your total."
        : emailType === "task_rejected"
          ? `Your submission needs another pass.${assignment.rejection_reason ? ` Reason: ${escapeHtml(assignment.rejection_reason)}` : ""}`
          : "A new task has been assigned to you.";
      const html = `<!doctype html><html><body style="margin:0;background:#f4f6f3;font-family:Arial,sans-serif;color:#1d2724"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 12px"><tr><td align="center"><table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff;border:1px solid #e4e9e5;border-radius:10px"><tr><td style="padding:32px"><div style="font-size:12px;font-weight:bold;letter-spacing:1px;color:#197a5b">TEAM TASKS</div><h1 style="font-size:24px;margin:22px 0 12px">${escapeHtml(emailSubjects[emailType])}</h1><p style="font-size:15px;line-height:1.6">Hi ${name}, ${message}</p><div style="margin:22px 0;padding:18px;background:#f6f7f5;border-radius:7px"><strong>${title}</strong><p style="font-size:14px;line-height:1.6;margin-bottom:0">${description}</p></div><a href="${appOrigin}/#tasks" style="display:inline-block;padding:12px 18px;background:#197a5b;color:white;text-decoration:none;border-radius:6px;font-weight:bold">Open Team Tasks</a><p style="margin:28px 0 0;color:#78827e;font-size:12px">You received this message because a task changed in your team workspace.</p></td></tr></table></td></tr></table></body></html>`;

      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: sender, to: [profile.email], subject: emailSubjects[emailType], html }),
        });
        if (!response.ok) throw new Error(`Resend returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
        await adminClient.rpc("finish_email", { p_log_id: logId, p_status: "sent", p_error_message: null });
        sent++;
      } catch (error) {
        const messageText = error instanceof Error ? error.message : "Email delivery failed";
        await adminClient.rpc("finish_email", { p_log_id: logId, p_status: "failed", p_error_message: messageText });
        failed++;
      }
    }

    return Response.json({ sent, failed }, { status: failed ? 207 : 200, headers: corsHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected email delivery error";
    return Response.json({ error: message }, { status: 500, headers: corsHeaders });
  }
});