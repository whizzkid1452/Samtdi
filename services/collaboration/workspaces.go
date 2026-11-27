package collaboration

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type workspace struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	OrganizationID string `json:"organization_id"`
	Owner          bool   `json:"owner"`
	CanCreate      bool   `json:"can_create"`
	Active         bool   `json:"active"`
	Personal       bool   `json:"personal"`
	Guest          bool   `json:"guest"`
}

func (s *Server) workspaceRoutes() {
	s.workspaceInvitationRoutes()
	s.mux.HandleFunc("GET /v1/workspaces", s.withSession(s.listWorkspaces))
	s.mux.HandleFunc("POST /v1/workspaces", s.withSession(s.createWorkspace))
	s.mux.HandleFunc("GET /v1/workspaces/{workspace}/members/{subject}/role", s.withSession(s.workspaceMemberRole))
	s.mux.HandleFunc("PATCH /v1/workspaces/{workspace}/members/{subject}/role", s.withSession(s.workspaceMemberRole))
	s.mux.HandleFunc("GET /v1/workspaces/{workspace}/members", s.withSession(s.workspaceMembers))
	s.mux.HandleFunc("POST /v1/workspaces/{workspace}/members", s.withSession(s.addWorkspaceMember))
	s.mux.HandleFunc("DELETE /v1/workspaces/{workspace}/members/{subject}", s.withSession(s.removeWorkspaceMember))
	s.mux.HandleFunc("PUT /v1/projects/{project}/workspace", s.withSession(s.attachProjectWorkspace))
}

func (s *Server) listWorkspaces(w http.ResponseWriter, r *http.Request, session Session) {
	workspaces := []workspace{}
	if s.logto != nil {
		rows, err := s.pool.Query(r.Context(), `SELECT id::text,requested_name,COALESCE(organization_id,''),active,created_by::text,personal
 FROM workspaces WHERE (active AND organization_id=ANY($1::text[])) OR (created_by=$2 AND (personal OR NOT active))
 ORDER BY personal DESC,created_at,id`, session.organizationIDs(), session.AccountID)
		if err != nil {
			internal(w, "list_workspaces", err)
			return
		}
		defer rows.Close()
		for rows.Next() {
			var entry workspace
			var creator string
			if err := rows.Scan(&entry.ID, &entry.Name, &entry.OrganizationID, &entry.Active, &creator, &entry.Personal); err != nil {
				internal(w, "read_workspace", err)
				return
			}
			organization, member := session.organizations[entry.OrganizationID]
			if entry.Personal {
				entry.Owner, entry.CanCreate = true, true
				workspaces = append(workspaces, entry)
			} else if member && entry.Active {
				entry.Name, entry.Owner = organization.Name, organization.isOwner()
				entry.CanCreate = organization.canCreateProject()
				entry.Guest = !entry.CanCreate
				workspaces = append(workspaces, entry)
			} else if !entry.Active && creator == session.AccountID {
				entry.Owner = true
				workspaces = append(workspaces, entry)
			}
		}
		if err := rows.Err(); err != nil {
			internal(w, "read_workspaces", err)
			return
		}
	}
	writeJSON(w, 200, map[string]any{"enabled": s.logto != nil, "workspaces": workspaces})
}

func (s *Server) createWorkspace(w http.ResponseWriter, r *http.Request, session Session) {
	var input struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	if s.logto == nil || !uuidPattern.MatchString(input.ID) || !webText(input.Name, 100) {
		problem(w, 400, "invalid_workspace")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	connection, err := s.pool.Acquire(ctx)
	if err != nil {
		internal(w, "workspace_connection", err)
		return
	}
	defer connection.Release()
	defer func() {
		cleanup, finish := context.WithTimeout(context.Background(), 5*time.Second)
		defer finish()
		if _, err := connection.Exec(cleanup, "SELECT pg_advisory_unlock(hashtextextended($1,814735205))", input.ID); err != nil {
			_ = connection.Conn().Close(cleanup)
		}
	}()
	if _, err := connection.Exec(ctx, "SELECT pg_advisory_lock(hashtextextended($1,814735205))", input.ID); err != nil {
		internal(w, "workspace_lock", err)
		return
	}

	inserted, err := connection.Exec(ctx, `INSERT INTO workspaces(id,requested_name,created_by) VALUES($1,$2,$3)
 ON CONFLICT(id) DO NOTHING`, input.ID, input.Name, session.AccountID)
	if err != nil {
		internal(w, "reserve_workspace", err)
		return
	}
	entry := workspace{ID: input.ID, Owner: true, CanCreate: true}

	var creator string
	err = connection.QueryRow(ctx, `SELECT requested_name,COALESCE(organization_id,''),active,created_by::text FROM workspaces WHERE id=$1`, input.ID).
		Scan(&entry.Name, &entry.OrganizationID, &entry.Active, &creator)
	if err != nil {
		internal(w, "read_reserved_workspace", err)
		return
	}
	if creator != session.AccountID || entry.Name != input.Name {
		problem(w, 409, "workspace_request_conflict")
		return
	}
	if entry.Active {
		organizations, err := s.logto.organizations(ctx, session.subject)
		if err != nil {
			writeWebError(w, "read_workspace_owner", err)
			return
		}
		var current logtoOrganization
		for _, organization := range organizations {
			if organization.ID == entry.OrganizationID {
				current = organization
				break
			}
		}
		if !current.isOwner() {
			problem(w, 404, "resource_not_found")
			return
		}
		entry.Name = current.Name
		writeJSON(w, 200, entry)
		return
	}
	if entry.OrganizationID == "" {
		var organization logtoOrganization
		if inserted.RowsAffected() == 1 {
			err = s.logto.call(ctx, "POST", "/organizations", map[string]any{
				"name": input.Name, "customData": map[string]string{"samtdiWorkspaceId": input.ID, "samtdiAccountId": session.AccountID},
			}, &organization)
		} else {
			// An interrupted POST may have succeeded remotely. Reconcile its marker, never blindly repeat it.
			organization, err = s.findWorkspaceOrganization(ctx, input.Name, input.ID, session.AccountID)
		}
		if err != nil {
			writeWebError(w, "provision_organization", err)
			return
		}
		entry.OrganizationID = organization.ID
		if _, err := connection.Exec(ctx, "UPDATE workspaces SET organization_id=$2 WHERE id=$1", input.ID, organization.ID); err != nil {
			internal(w, "link_workspace_organization", err)
			return
		}
	}
	if err := s.logto.ensureMember(ctx, entry.OrganizationID, session.subject, "samtdi-owner"); err != nil {
		writeWebError(w, "workspace_owner_membership", err)
		return
	}
	if err := s.logto.ensureRole(ctx, entry.OrganizationID, session.subject, "samtdi-owner"); err != nil {
		writeWebError(w, "workspace_owner_role", err)
		return
	}
	if _, err := connection.Exec(ctx, "UPDATE workspaces SET active=true WHERE id=$1", input.ID); err != nil {
		internal(w, "activate_workspace", err)
		return
	}
	entry.Active = true
	writeJSON(w, 201, entry)
}

func (s *Server) findWorkspaceOrganization(ctx context.Context, name, id, account string) (logtoOrganization, error) {
	for page := 1; ; page++ {
		var organizations []logtoOrganization
		query := url.Values{"q": {name}, "page": {strconv.Itoa(page)}, "page_size": {"100"}}
		if err := s.logto.call(ctx, "GET", "/organizations?"+query.Encode(), nil, &organizations); err != nil {
			return logtoOrganization{}, err
		}
		for _, organization := range organizations {
			if organization.CustomData["samtdiWorkspaceId"] == id && organization.CustomData["samtdiAccountId"] == account {
				return organization, nil
			}
		}
		if len(organizations) < 100 {
			return logtoOrganization{}, webProblem{409, "workspace_provisioning_pending"}
		}
	}
}

func (s *Server) readWorkspace(ctx context.Context, id string, session Session, owner bool) (workspace, error) {
	if s.logto == nil || !uuidPattern.MatchString(id) {
		return workspace{}, pgx.ErrNoRows
	}

	var entry workspace
	var creator string
	err := s.pool.QueryRow(ctx, "SELECT id::text,requested_name,COALESCE(organization_id,''),personal,created_by::text FROM workspaces WHERE id=$1 AND active", id).
		Scan(&entry.ID, &entry.Name, &entry.OrganizationID, &entry.Personal, &creator)
	if err != nil {
		return workspace{}, err
	}
	if entry.Personal {
		if owner || creator != session.AccountID {
			return workspace{}, pgx.ErrNoRows
		}

		entry.Owner, entry.Active, entry.CanCreate = true, true, true
		return entry, nil
	}

	organization, member := session.organizations[entry.OrganizationID]
	if !member {
		return workspace{}, pgx.ErrNoRows
	}
	entry.Name, entry.Owner, entry.Active = organization.Name, organization.isOwner(), true
	if owner && !entry.Owner {
		return workspace{}, webProblem{403, "workspace_owner_required"}
	}
	return entry, nil
}

func (s *Server) workspaceMembers(w http.ResponseWriter, r *http.Request, session Session) {
	entry, err := s.readWorkspace(r.Context(), r.PathValue("workspace"), session, true)
	if err != nil {
		writeWebError(w, "read_workspace", err)
		return
	}

	page, err := strconv.Atoi(r.URL.Query().Get("page"))
	if r.URL.Query().Get("page") == "" {
		page, err = 1, nil
	}
	if err != nil || page < 1 {
		problem(w, 400, "invalid_page")
		return
	}

	var members []logtoUser
	err = s.logto.call(r.Context(), "GET", "/organizations/"+url.PathEscape(entry.OrganizationID)+"/users?page="+strconv.Itoa(page)+"&page_size=100", nil, &members)
	if err != nil {
		writeWebError(w, "list_workspace_members", err)
		return
	}
	writeJSON(w, 200, members)
}

func (s *Server) addWorkspaceMember(w http.ResponseWriter, r *http.Request, session Session) {
	entry, err := s.readWorkspace(r.Context(), r.PathValue("workspace"), session, true)
	if err != nil {
		writeWebError(w, "read_workspace", err)
		return
	}

	var input struct {
		Email string `json:"email"`
	}
	if !readJSON(w, r, &input) {
		return
	}

	email, err := verifiedEmail(input.Email)
	if err != nil {
		problem(w, 400, "invalid_email")
		return
	}

	var users []logtoUser
	if err := s.logto.call(r.Context(), "GET", "/users?"+url.Values{"search.primaryEmail": {email}, "page_size": {"100"}}.Encode(), nil, &users); err != nil {
		writeWebError(w, "find_workspace_member", err)
		return
	}
	for _, user := range users {
		if strings.EqualFold(user.Email, email) {
			if err := s.logto.ensureMember(r.Context(), entry.OrganizationID, user.ID, "samtdi-member"); err != nil {
				writeWebError(w, "add_workspace_member", err)
				return
			}
			w.WriteHeader(204)
			return
		}
	}
	problem(w, 404, "registered_user_not_found")
}

func (s *Server) removeWorkspaceMember(w http.ResponseWriter, r *http.Request, session Session) {
	entry, err := s.readWorkspace(r.Context(), r.PathValue("workspace"), session, true)
	if err != nil {
		writeWebError(w, "read_workspace", err)
		return
	}
	subject := r.PathValue("subject")
	if !logtoID.MatchString(subject) || subject == session.subject {
		problem(w, 409, "workspace_owner_cannot_leave")
		return
	}

	var roles []organizationRole
	path := "/organizations/" + url.PathEscape(entry.OrganizationID) + "/users/" + url.PathEscape(subject)
	if err := s.logto.call(r.Context(), "GET", path+"/roles", nil, &roles); err != nil {
		writeWebError(w, "read_workspace_member_roles", err)
		return
	}
	if (logtoOrganization{Roles: roles}).isOwner() {
		problem(w, 409, "workspace_owner_cannot_leave")
		return
	}
	if err := s.logto.call(r.Context(), "DELETE", path, nil, nil); err != nil {
		writeWebError(w, "remove_workspace_member", err)
		return
	}
	w.WriteHeader(204)
}

func (s *Server) attachProjectWorkspace(w http.ResponseWriter, r *http.Request, session Session) {
	var input struct {
		WorkspaceID string `json:"workspace_id"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	entry, err := s.readWorkspace(r.Context(), input.WorkspaceID, session, true)
	if err != nil {
		writeWebError(w, "read_destination_workspace", err)
		return
	}
	ctx := r.Context()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		internal(w, "begin_project_workspace", err)
		return
	}
	defer tx.Rollback(ctx)
	project := r.PathValue("project")
	if err := lockProject(ctx, tx, project); err != nil {
		writeWebError(w, "lock_project_workspace", err)
		return
	}
	role, err := readRole(ctx, tx, project, session.AccountID)
	if !requireRole(w, role, err, role == Owner) {
		return
	}
	// A project move must not silently revoke any existing collaborator's access.
	rows, err := tx.Query(ctx, `SELECT a.id::text,COALESCE(i.subject,CASE WHEN a.issuer=$2 THEN a.subject ELSE '' END)
 FROM memberships m JOIN accounts a ON a.id=m.account_id
 LEFT JOIN account_identities i ON i.account_id=a.id AND i.issuer=$2 WHERE m.project_id=$1`, project, s.logto.issuer)
	if err != nil {
		internal(w, "read_project_identities", err)
		return
	}
	type accountIdentity struct{ Account, Subject string }
	members, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (accountIdentity, error) {
		var identity accountIdentity
		err := row.Scan(&identity.Account, &identity.Subject)
		return identity, err
	})
	if err != nil {
		internal(w, "read_project_identities", err)
		return
	}
	for _, member := range members {
		if member.Subject == "" {
			problem(w, 409, "project_member_identity_link_required")
			return
		}
		organizations, err := s.logto.organizations(ctx, member.Subject)
		if err != nil {
			writeWebError(w, "read_member_organizations", err)
			return
		}
		found := false
		for _, organization := range organizations {
			found = found || organization.ID == entry.OrganizationID
		}
		if !found {
			problem(w, 409, "project_member_workspace_required")
			return
		}
	}
	if _, err := tx.Exec(ctx, "UPDATE projects SET workspace_id=$2 WHERE id=$1", project, entry.ID); err != nil {
		internal(w, "attach_workspace", err)
		return
	}
	if err := appendWebActivity(ctx, tx, project, session.AccountID, "project.workspace_changed", project, map[string]any{"workspace_id": entry.ID}); err != nil {
		internal(w, "project_workspace_activity", err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		internal(w, "commit_workspace", err)
		return
	}
	w.WriteHeader(204)
}
