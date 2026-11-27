package collaboration

import (
	"net/http"
	"net/url"

	"github.com/jackc/pgx/v5"
)

func (s *Server) workspaceMemberRole(w http.ResponseWriter, r *http.Request, session Session) {
	ctx := r.Context()
	entry, err := s.readWorkspace(ctx, r.PathValue("workspace"), session, true)
	if err != nil {
		writeWebError(w, "read_workspace", err)
		return
	}
	subject := r.PathValue("subject")
	if !logtoID.MatchString(subject) || subject == session.subject {
		problem(w, http.StatusForbidden, "workspace_owner_role_locked")
		return
	}

	path := "/organizations/" + url.PathEscape(entry.OrganizationID) + "/users/" + url.PathEscape(subject) + "/roles"
	var roles []organizationRole
	if err := s.logto.call(ctx, "GET", path, nil, &roles); err != nil {
		writeWebError(w, "read_workspace_member_roles", err)
		return
	}
	otherRoles := []string{}
	hasMemberRole := false
	for _, role := range roles {
		switch role.Name {
		case "samtdi-owner":
			problem(w, http.StatusForbidden, "workspace_owner_role_locked")
			return
		case "samtdi-member", "samtdi-guest":
			hasMemberRole = true
		default:
			otherRoles = append(otherRoles, role.Name)
		}
	}
	if !hasMemberRole {
		problem(w, http.StatusNotFound, "workspace_member_not_found")
		return
	}

	if r.Method == http.MethodGet {
		rows, err := s.pool.Query(ctx, `SELECT p.title FROM projects p JOIN memberships m ON m.project_id=p.id
 WHERE p.workspace_id=$1 AND m.account_id IN (
  SELECT id FROM accounts WHERE issuer=$2 AND subject=$3
  UNION SELECT account_id FROM account_identities WHERE issuer=$2 AND subject=$3
 ) ORDER BY p.title,p.id`, entry.ID, s.logto.issuer, subject)
		if err != nil {
			internal(w, "read_workspace_member_projects", err)
			return
		}
		projects, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			internal(w, "read_workspace_member_projects", err)
			return
		}
		writeJSON(w, http.StatusOK, map[string][]string{"projects": projects})
		return
	}

	var input struct {
		Role string `json:"role"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	if input.Role != "member" && input.Role != "guest" {
		problem(w, http.StatusBadRequest, "invalid_workspace_role")
		return
	}

	if err := s.logto.call(ctx, "PUT", path, map[string]any{
		"organizationRoleNames": append(otherRoles, "samtdi-"+input.Role),
	}, nil); err != nil {
		writeWebError(w, "change_workspace_member_role", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
