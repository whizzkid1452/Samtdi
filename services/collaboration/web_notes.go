package collaboration

import (
	"context"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
)

type webReply struct {
	ID       string `json:"id"`
	AuthorID string `json:"author_id"`
	Email    string `json:"email"`
	Body     string `json:"body"`
	Deleted  bool   `json:"deleted"`
	Revision int    `json:"revision"`
}

type webNote struct {
	ID        string     `json:"id"`
	VersionID string     `json:"version_id"`
	AuthorID  string     `json:"author_id"`
	Email     string     `json:"email"`
	StartMS   int64      `json:"start_ms"`
	EndMS     *int64     `json:"end_ms,omitempty"`
	Body      string     `json:"body"`
	Resolved  bool       `json:"resolved"`
	Deleted   bool       `json:"deleted"`
	Revision  int        `json:"revision"`
	Replies   []webReply `json:"replies"`
}

const webNotesSelect = `SELECT n.id::text,n.version_id::text,n.author_id::text,a.email,n.start_ms,n.end_ms,
 CASE WHEN n.deleted THEN '' ELSE n.body END,n.resolved,n.deleted,n.revision,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'author_id',r.author_id,'email',ra.email,
 'body',CASE WHEN r.deleted THEN '' ELSE r.body END,'deleted',r.deleted,'revision',r.revision)
 ORDER BY r.created_at,r.id)
 FROM web_note_replies r JOIN accounts ra ON ra.id=r.author_id WHERE r.note_id=n.id),'[]'::jsonb)
 FROM web_notes n JOIN accounts a ON a.id=n.author_id`

func (s *Server) webNoteRoutes() {
	base := "/v1/projects/{project}/versions/{version}/notes"
	s.mux.HandleFunc("GET "+base, s.withSession(s.listWebNotes))
	s.mux.HandleFunc("POST "+base, s.withSession(s.createWebNote))
	s.mux.HandleFunc("PATCH "+base+"/{note}", s.withSession(s.changeWebNote))
	s.mux.HandleFunc("POST "+base+"/{note}/replies", s.withSession(s.createWebReply))
	s.mux.HandleFunc("PATCH "+base+"/{note}/replies/{reply}", s.withSession(s.changeWebReply))
}

func (s *Server) listWebNotes(w http.ResponseWriter, r *http.Request, session Session) {
	if !s.webRead(w, r, session) {
		return
	}
	project, version, before := r.PathValue("project"), r.PathValue("version"), r.URL.Query().Get("before")
	if !uuidPattern.MatchString(version) || (before != "" && !uuidPattern.MatchString(before)) {
		problem(w, 400, "invalid_notes_query")
		return
	}
	rows, err := s.pool.Query(r.Context(), webNotesSelect+` WHERE n.project_id=$1 AND n.version_id=$2
 AND ($3='' OR (n.created_at,n.id)<(SELECT created_at,id FROM web_notes WHERE project_id=$1 AND version_id=$2 AND id=NULLIF($3,'')::uuid))
 ORDER BY n.created_at DESC,n.id DESC LIMIT 100`, project, version, before)
	if err != nil {
		internal(w, "list_web_notes", err)
		return
	}
	notes, err := pgx.CollectRows(rows, pgx.RowToStructByPos[webNote])
	if err != nil {
		internal(w, "read_web_notes", err)
		return
	}
	writeJSON(w, 200, notes)
}

func (s *Server) createWebNote(w http.ResponseWriter, r *http.Request, session Session) {
	var input struct {
		StartMS *int64 `json:"start_ms"`
		EndMS   *int64 `json:"end_ms"`
		Body    string `json:"body"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	project, version := r.PathValue("project"), r.PathValue("version")
	if !uuidPattern.MatchString(version) || input.StartMS == nil || *input.StartMS < 0 || !webText(input.Body, 4000) {
		problem(w, 400, "invalid_note")
		return
	}
	s.webWrite(w, r, session, Reviewer, false, 201, func(ctx context.Context, tx pgx.Tx, _ Role) (any, error) {
		var duration int64
		err := tx.QueryRow(ctx, `SELECT v.duration_ms FROM web_media_versions v JOIN web_media_items m ON m.id=v.item_id
 WHERE v.project_id=$1 AND v.id=$2 AND v.state='ready' AND m.archived_at IS NULL`, project, version).Scan(&duration)
		if err != nil {
			return nil, err
		}
		if *input.StartMS > duration || (input.EndMS != nil && (*input.EndMS <= *input.StartMS || *input.EndMS > duration)) {
			return nil, webProblem{400, "note_time_out_of_range"}
		}
		var id string
		err = tx.QueryRow(ctx, `INSERT INTO web_notes(project_id,version_id,author_id,start_ms,end_ms,body)
 VALUES ($1,$2,$3,$4,$5,$6) RETURNING id::text`, project, version, session.AccountID, *input.StartMS, input.EndMS, strings.TrimSpace(input.Body)).Scan(&id)
		if err != nil {
			return nil, err
		}
		return map[string]string{"id": id}, appendWebActivity(ctx, tx, project, session.AccountID, "note.created", id, map[string]any{"version_id": version})
	})
}

type webMessageUpdate struct {
	Revision int     `json:"revision"`
	Body     *string `json:"body"`
	Deleted  bool    `json:"deleted"`
	Resolved *bool   `json:"resolved"`
}

func (input webMessageUpdate) valid(allowResolved bool) bool {
	return input.Revision > 0 && (input.Body != nil || input.Deleted || input.Resolved != nil) &&
		(input.Body == nil || webText(*input.Body, 4000)) && (allowResolved || input.Resolved == nil)
}

func recordWebMessageEdit(ctx context.Context, tx pgx.Tx, project, subject, actor string, revision int, body string) error {
	_, err := tx.Exec(ctx, `INSERT INTO web_note_edits(project_id,subject_id,actor_id,revision,previous_body)
 VALUES ($1,$2,$3,$4,$5)`, project, subject, actor, revision, body)
	return err
}

func (s *Server) changeWebNote(w http.ResponseWriter, r *http.Request, session Session) {
	var input webMessageUpdate
	if !readJSON(w, r, &input) {
		return
	}
	project, version, note := r.PathValue("project"), r.PathValue("version"), r.PathValue("note")
	if !input.valid(true) || !uuidPattern.MatchString(version) || !uuidPattern.MatchString(note) {
		problem(w, 400, "invalid_note_update")
		return
	}
	s.webWrite(w, r, session, Reviewer, false, 204, func(ctx context.Context, tx pgx.Tx, role Role) (any, error) {
		var author, body string
		var revision int
		var resolved bool
		err := tx.QueryRow(ctx, `SELECT author_id::text,body,revision,resolved FROM web_notes
 WHERE project_id=$1 AND version_id=$2 AND id=$3 AND NOT deleted`, project, version, note).Scan(&author, &body, &revision, &resolved)
		if err != nil {
			return nil, err
		}
		if author != session.AccountID && (input.Body != nil || input.Deleted || !role.canWrite()) {
			return nil, webProblem{403, "insufficient_role"}
		}
		if revision != input.Revision {
			return nil, webProblem{409, "revision_conflict"}
		}
		if input.Body != nil || input.Deleted {
			if err = recordWebMessageEdit(ctx, tx, project, note, session.AccountID, revision, body); err != nil {
				return nil, err
			}
		}
		if input.Body != nil {
			body = strings.TrimSpace(*input.Body)
		}
		if input.Resolved != nil {
			resolved = *input.Resolved
		}
		_, err = tx.Exec(ctx, "UPDATE web_notes SET body=$2,deleted=$3,resolved=$4,revision=revision+1 WHERE id=$1", note, body, input.Deleted, resolved)
		if err != nil {
			return nil, err
		}
		return nil, appendWebActivity(ctx, tx, project, session.AccountID, "note.updated", note, map[string]any{"version_id": version, "resolved": resolved, "deleted": input.Deleted})
	})
}

func (s *Server) createWebReply(w http.ResponseWriter, r *http.Request, session Session) {
	var input struct {
		Body string `json:"body"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	project, version, note := r.PathValue("project"), r.PathValue("version"), r.PathValue("note")
	if !uuidPattern.MatchString(version) || !uuidPattern.MatchString(note) || !webText(input.Body, 4000) {
		problem(w, 400, "invalid_reply")
		return
	}
	s.webWrite(w, r, session, Reviewer, false, 201, func(ctx context.Context, tx pgx.Tx, _ Role) (any, error) {
		var id string
		err := tx.QueryRow(ctx, `INSERT INTO web_note_replies(project_id,note_id,author_id,body)
 SELECT $1,id,$4,$5 FROM web_notes WHERE project_id=$1 AND version_id=$2 AND id=$3 AND NOT deleted
 RETURNING id::text`, project, version, note, session.AccountID, strings.TrimSpace(input.Body)).Scan(&id)
		if err != nil {
			return nil, err
		}
		return map[string]string{"id": id}, appendWebActivity(ctx, tx, project, session.AccountID, "reply.created", id, map[string]any{"note_id": note, "version_id": version})
	})
}

func (s *Server) changeWebReply(w http.ResponseWriter, r *http.Request, session Session) {
	var input webMessageUpdate
	if !readJSON(w, r, &input) {
		return
	}
	project, version, note, reply := r.PathValue("project"), r.PathValue("version"), r.PathValue("note"), r.PathValue("reply")
	if !input.valid(false) || !uuidPattern.MatchString(version) || !uuidPattern.MatchString(note) || !uuidPattern.MatchString(reply) {
		problem(w, 400, "invalid_reply_update")
		return
	}
	s.webWrite(w, r, session, Reviewer, false, 204, func(ctx context.Context, tx pgx.Tx, _ Role) (any, error) {
		var author, body string
		var revision int
		err := tx.QueryRow(ctx, `SELECT r.author_id::text,r.body,r.revision FROM web_note_replies r
 JOIN web_notes n ON n.id=r.note_id WHERE r.project_id=$1 AND n.version_id=$2 AND n.id=$3 AND r.id=$4 AND NOT r.deleted`, project, version, note, reply).
			Scan(&author, &body, &revision)
		if err != nil {
			return nil, err
		}
		if author != session.AccountID {
			return nil, webProblem{403, "insufficient_role"}
		}
		if revision != input.Revision {
			return nil, webProblem{409, "revision_conflict"}
		}
		if err = recordWebMessageEdit(ctx, tx, project, reply, session.AccountID, revision, body); err != nil {
			return nil, err
		}
		if input.Body != nil {
			body = strings.TrimSpace(*input.Body)
		}
		_, err = tx.Exec(ctx, "UPDATE web_note_replies SET body=$2,deleted=$3,revision=revision+1 WHERE id=$1", reply, body, input.Deleted)
		if err != nil {
			return nil, err
		}
		return nil, appendWebActivity(ctx, tx, project, session.AccountID, "reply.updated", reply, map[string]any{"note_id": note, "version_id": version, "deleted": input.Deleted})
	})
}
