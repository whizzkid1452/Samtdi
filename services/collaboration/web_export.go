package collaboration

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
)

type webExportRecord struct {
	Kind string `json:"kind"`
	Data any    `json:"data"`
}

func (s *Server) webExportRoutes() {
	s.mux.HandleFunc("GET /v1/projects/{project}/export/{format}", s.withSession(s.exportWebProject))
}

func (s *Server) exportWebProject(w http.ResponseWriter, r *http.Request, session Session) {
	format := r.PathValue("format")
	if format != "json" && format != "csv" {
		problem(w, 404, "resource_not_found")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	project := r.PathValue("project")
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		internal(w, "begin_export", err)
		return
	}
	defer tx.Rollback(ctx)
	role, err := readRole(ctx, tx, project, session.AccountID)
	if !requireRole(w, role, err, role.valid()) {
		return
	}
	output, err := os.CreateTemp("", "samtdi-export-*")
	if err != nil {
		internal(w, "open_export", err)
		return
	}
	defer os.Remove(output.Name())
	defer output.Close()

	exportedAt := time.Now().UTC().Format(time.RFC3339)
	err = writeWebExport(ctx, tx, output, format, project, exportedAt)
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		internal(w, "write_export", err)
		return
	}
	size, err := output.Seek(0, io.SeekCurrent)
	if err == nil {
		_, err = output.Seek(0, io.SeekStart)
	}
	if err != nil {
		internal(w, "read_export", err)
		return
	}

	contentType := "application/json"
	if format == "csv" {
		contentType = "text/csv; charset=utf-8"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("Content-Disposition", `attachment; filename="samtdi-project.`+format+`"`)
	w.WriteHeader(200)
	_, _ = io.Copy(w, output)
}

func eachWebExportRecord(ctx context.Context, tx pgx.Tx, project string, emit func(webExportRecord) error) error {
	notes, err := tx.Query(ctx, webNotesSelect+" WHERE n.project_id=$1 ORDER BY n.created_at,n.id", project)
	if err != nil {
		return err
	}
	defer notes.Close()
	for notes.Next() {
		note, err := pgx.RowToStructByPos[webNote](notes)
		if err != nil {
			return err
		}
		if err = emit(webExportRecord{"note", note}); err != nil {
			return err
		}
	}
	if err = notes.Err(); err != nil {
		return err
	}
	notes.Close()
	tasks, err := tx.Query(ctx, webTaskSelect+" WHERE t.project_id=$1 ORDER BY t.created_at,t.id", project)
	if err != nil {
		return err
	}
	defer tasks.Close()
	for tasks.Next() {
		task, err := pgx.RowToStructByPos[webTask](tasks)
		if err != nil {
			return err
		}
		if err = emit(webExportRecord{"task", task}); err != nil {
			return err
		}
	}
	return tasks.Err()
}

func writeWebExport(ctx context.Context, tx pgx.Tx, output io.Writer, format, project, exportedAt string) error {
	if format == "json" {
		if _, err := fmt.Fprintf(output, `{"format_version":1,"project_id":%q,"exported_at":%q,"time_unit":"ms","records":[`, project, exportedAt); err != nil {
			return err
		}
		encoder := json.NewEncoder(output)
		first := true
		err := eachWebExportRecord(ctx, tx, project, func(record webExportRecord) error {
			if !first {
				if _, err := io.WriteString(output, ","); err != nil {
					return err
				}
			}
			first = false
			return encoder.Encode(record)
		})
		if err != nil {
			return err
		}
		_, err = io.WriteString(output, "]}\n")
		return err
	}

	writer := csv.NewWriter(output)
	if err := writer.Write([]string{"format_version", "exported_at", "project_id", "kind", "id", "version_id", "start_ms", "end_ms", "text", "status", "assignee_id", "due_on", "note_ids", "reply_to", "revision", "archived_or_deleted"}); err != nil {
		return err
	}
	write := func(row ...string) error {
		for i, value := range row {
			row[i] = safeWebCSV(value)
		}
		return writer.Write(append([]string{"1", exportedAt, project}, row...))
	}
	err := eachWebExportRecord(ctx, tx, project, func(record webExportRecord) error {
		switch value := record.Data.(type) {
		case webNote:
			end := ""
			if value.EndMS != nil {
				end = strconv.FormatInt(*value.EndMS, 10)
			}
			status := "open"
			if value.Resolved {
				status = "resolved"
			}
			if err := write("note", value.ID, value.VersionID, strconv.FormatInt(value.StartMS, 10), end, value.Body, status, "", "", "", "", strconv.Itoa(value.Revision), strconv.FormatBool(value.Deleted)); err != nil {
				return err
			}
			for _, reply := range value.Replies {
				if err := write("reply", reply.ID, value.VersionID, "", "", reply.Body, "", "", "", "", value.ID, strconv.Itoa(reply.Revision), strconv.FormatBool(reply.Deleted)); err != nil {
					return err
				}
			}
		case webTask:
			ids := make([]string, 0, len(value.Notes))
			for _, note := range value.Notes {
				ids = append(ids, note.ID)
			}
			return write("task", value.ID, value.ResultVersionID, "", "", value.Title+"\n"+value.Description+"\n"+value.ReviewText,
				value.Status, value.AssigneeID, value.DueOn, strings.Join(ids, " "), "", strconv.Itoa(value.Revision), strconv.FormatBool(value.Archived))
		}
		return nil
	})
	if err != nil {
		return err
	}
	writer.Flush()
	return writer.Error()
}

func safeWebCSV(value string) string {
	trimmed := strings.TrimLeftFunc(value, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) })
	if trimmed != "" && strings.ContainsRune("=+-@＝＋－＠", []rune(trimmed)[0]) {
		return "'" + value
	}
	return value
}
