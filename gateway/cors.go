package gateway

import "net/http"

// writeCORS sets CORS headers for browser beacon endpoints.
//
// navigator.sendBeacon always sends cross-origin requests in credentials mode
// "include", and browsers reject a credentialed response that carries the
// wildcard "Access-Control-Allow-Origin: *". So reflect the caller's Origin and
// allow credentials; fall back to "*" for non-browser callers that send no
// Origin (server-side SDKs, curl).
func writeCORS(w http.ResponseWriter, r *http.Request) {
	if origin := r.Header.Get("Origin"); origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Add("Vary", "Origin")
	} else {
		w.Header().Set("Access-Control-Allow-Origin", "*")
	}
}
