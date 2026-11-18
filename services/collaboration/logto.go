package collaboration

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/clientcredentials"
)

type LogtoConfig struct {
	Endpoint     string
	ClientID     string
	ClientSecret string
	Resource     string
}

type logtoClient struct {
	endpoint string
	issuer   string
	client   *http.Client
}

type organizationRole struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type logtoOrganization struct {
	ID         string             `json:"id"`
	Name       string             `json:"name"`
	Roles      []organizationRole `json:"organizationRoles"`
	CustomData map[string]any     `json:"customData"`
}

func (o logtoOrganization) isOwner() bool {
	for _, role := range o.Roles {
		if role.Name == "samtdi-owner" {
			return true
		}
	}
	return false
}

func (o logtoOrganization) canCreateProject() bool {
	for _, role := range o.Roles {
		if role.Name == "samtdi-owner" || role.Name == "samtdi-member" {
			return true
		}
	}
	return false
}

type logtoUser struct {
	ID        string             `json:"id"`
	Email     string             `json:"primaryEmail"`
	Name      string             `json:"name"`
	Roles     []organizationRole `json:"organizationRoles"`
	Suspended bool               `json:"isSuspended"`
}

var logtoID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func newLogtoClient(config Config, transport *http.Client) (*logtoClient, error) {
	settings := config.Logto
	if settings == (LogtoConfig{}) {
		return nil, nil
	}

	endpoint, err := url.Parse(settings.Endpoint)
	if err != nil || !validEndpoint(endpoint, config.AllowLoopbackHTTP) || endpoint.Path != "" ||
		settings.ClientID == "" || settings.ClientSecret == "" || settings.Resource == "" ||
		config.Issuer != settings.Endpoint+"/oidc" {
		return nil, errors.New("valid Logto endpoint, issuer and Management API credentials are required")
	}

	ctx := context.WithValue(context.Background(), oauth2.HTTPClient, transport)
	credentials := clientcredentials.Config{
		ClientID: settings.ClientID, ClientSecret: settings.ClientSecret,
		TokenURL: settings.Endpoint + "/oidc/token", Scopes: []string{"all"},
		EndpointParams: url.Values{"resource": {settings.Resource}}, AuthStyle: oauth2.AuthStyleInHeader,
	}
	client := credentials.Client(ctx)
	client.Timeout = 10 * time.Second
	client.CheckRedirect = transport.CheckRedirect
	return &logtoClient{endpoint: settings.Endpoint, issuer: config.Issuer, client: client}, nil
}

func (c *logtoClient) call(ctx context.Context, method, path string, input, output any) error {
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(encoded)
	}

	request, err := http.NewRequestWithContext(ctx, method, c.endpoint+"/api"+path, body)
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := c.client.Do(request)
	if err != nil {
		return webProblem{503, "identity_service_unavailable"}
	}
	defer response.Body.Close()
	if response.StatusCode == 404 || response.StatusCode == 422 {
		return webProblem{404, "organization_member_not_found"}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return webProblem{503, "identity_service_unavailable"}
	}
	if output != nil && json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(output) != nil {
		return webProblem{503, "identity_response_invalid"}
	}
	return nil
}

func (c *logtoClient) organizations(ctx context.Context, subject string) ([]logtoOrganization, error) {
	var organizations []logtoOrganization
	err := c.call(ctx, "GET", "/users/"+url.PathEscape(subject)+"/organizations", nil, &organizations)
	return organizations, err
}

func (c *logtoClient) ensureMember(ctx context.Context, organization, subject, role string) error {
	organizations, err := c.organizations(ctx, subject)
	if err != nil {
		return err
	}
	for _, known := range organizations {
		if known.ID == organization {
			if len(known.Roles) == 0 {
				return c.ensureRole(ctx, organization, subject, role)
			}
			return nil
		}
	}

	path := "/organizations/" + url.PathEscape(organization) + "/users"
	if err := c.call(ctx, "POST", path, map[string]any{"userIds": []string{subject}}, nil); err != nil {
		return err
	}
	return c.ensureRole(ctx, organization, subject, role)
}

func (c *logtoClient) ensureRole(ctx context.Context, organization, subject, name string) error {
	path := "/organizations/" + url.PathEscape(organization) + "/users/" + url.PathEscape(subject) + "/roles"
	var roles []organizationRole
	if err := c.call(ctx, "GET", path, nil, &roles); err != nil {
		return err
	}
	for _, role := range roles {
		if role.Name == name {
			return nil
		}
	}
	return c.call(ctx, "POST", path, map[string]any{"organizationRoleNames": []string{name}}, nil)
}

func (s *Server) loadOrganizations(ctx context.Context, session *Session) error {
	if s.logto == nil {
		return nil
	}
	err := s.pool.QueryRow(ctx, `SELECT subject FROM (
 SELECT subject FROM accounts WHERE id=$1 AND issuer=$2
 UNION SELECT subject FROM account_identities WHERE account_id=$1 AND issuer=$2) identities`,
		session.AccountID, s.logto.issuer).Scan(&session.subject)
	if errors.Is(err, pgx.ErrNoRows) {
		return webProblem{403, "identity_link_required"}
	}
	if err != nil {
		return err
	}

	var user logtoUser
	if err := s.logto.call(ctx, "GET", "/users/"+url.PathEscape(session.subject), nil, &user); err != nil {
		return err
	}
	if user.ID != session.subject {
		return webProblem{503, "identity_response_invalid"}
	}
	if user.Suspended {
		return webProblem{403, "account_suspended"}
	}

	organizations, err := s.logto.organizations(ctx, session.subject)
	if err != nil {
		return err
	}
	session.organizations = make(map[string]logtoOrganization, len(organizations))
	for _, organization := range organizations {
		session.organizations[organization.ID] = organization
	}
	return nil
}

func (s *Server) authorizeWorkspaceProject(ctx context.Context, projectID string, session Session) error {
	if projectID == "" || !uuidPattern.MatchString(projectID) {
		return nil
	}

	var organization string
	var scoped, active bool
	err := s.pool.QueryRow(ctx, `SELECT p.workspace_id IS NOT NULL,COALESCE(w.organization_id,''),COALESCE(w.active,false) FROM projects p
 LEFT JOIN workspaces w ON w.id=p.workspace_id WHERE p.id=$1`, projectID).Scan(&scoped, &organization, &active)
	if err != nil {
		return err
	}
	if scoped {
		if !active || organization == "" {
			return webProblem{503, "workspace_not_ready"}
		}
		if s.logto == nil {
			return webProblem{503, "workspace_identity_unavailable"}
		}
		if _, member := session.organizations[organization]; !member {
			return pgx.ErrNoRows
		}
	}
	return nil
}

// LinkLogtoIdentity is an operator-run migration. Email equality alone never links an interactive login.
func LinkLogtoIdentity(ctx context.Context, pool *pgxpool.Pool, config Config, accountID, subject string) error {
	if !uuidPattern.MatchString(accountID) || !logtoID.MatchString(subject) {
		return errors.New("invalid identity link")
	}

	client, err := newLogtoClient(config, &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }})
	if err != nil || client == nil {
		return errors.New("Logto Management API configuration is required")
	}

	var user logtoUser
	if err := client.call(ctx, "GET", "/users/"+url.PathEscape(subject), nil, &user); err != nil {
		return err
	}

	var email string
	if err := pool.QueryRow(ctx, "SELECT email FROM accounts WHERE id=$1", accountID).Scan(&email); err != nil {
		return err
	}

	verified, err := verifiedEmail(user.Email)
	if err != nil || verified != email || user.ID != subject || user.Suspended {
		return errors.New("operator link requires the same verified Logto email")
	}
	_, err = pool.Exec(ctx, `INSERT INTO account_identities(issuer,subject,account_id) VALUES($1,$2,$3)
 ON CONFLICT(issuer,subject) DO UPDATE SET account_id=EXCLUDED.account_id
 WHERE account_identities.account_id=EXCLUDED.account_id`, config.Issuer, subject, accountID)
	if err != nil {
		return err
	}

	var linked string
	if err := pool.QueryRow(ctx, "SELECT account_id::text FROM account_identities WHERE issuer=$1 AND subject=$2", config.Issuer, subject).Scan(&linked); err != nil {
		return err
	}
	if linked != accountID {
		return errors.New("identity already belongs to another account")
	}
	return nil
}

func (s Session) organizationIDs() []string {
	ids := make([]string, 0, len(s.organizations))
	for id := range s.organizations {
		ids = append(ids, id)
	}
	return ids
}
