/**
 * A class to handle signing in and out and caching session data in sessionStore
 *
 * Note: We use XMLHttpRequest() here rather than fetch because fetch() uses
 * Service Workers and they cannot share cookies with the browser session
 * yet (!) so if we tried to get or pass the CSRF token it would mismatch.
 * https://github.com/iaincollins/nextjs-starter
 * removed all the csrf stuff and changed to JSON only
 */
export default class Session {

  constructor({req} = {}) {
    this._session = {}

    try {
      if (req) {
        // If running on server we can access the server side environment
        this._session = {
          isLoggedIn: (req.session.user) ? true : false,
        }
        if (req.session.user)
          this._session.user = req.session.user
      } else {
        // If running on client, attempt to load session from localStorage
        this._session = this._getSessionStore()
      }
    } catch (e) {
      // Handle if error reading from localStorage or server state is safe to
      // ignore (will just cause session data to be fetched by ajax)
      return
    }
  }

  // We can't do async requests in the constructor so access is via asyc method
  // This allows us to use XMLHttpRequest when running on the client to fetch it
  // Note: We use XMLHttpRequest instead of fetch so auth cookies are passed
  async getSession(forceUpdate) {
    console.log("getSession")
    // If running on the server, return session as will be loaded in constructor
    if (typeof window === 'undefined')
      return new Promise((resolve) => {
        resolve(this._session)
      })

    // Attempt to load session data from sessionStore on every call
    this._session = this._getSessionStore()

    if (this._session && Object.keys(this._session).length > 0 && forceUpdate !== true) {
      // If we have a populated session object already AND forceUpdate is not
      // set to true then return the session data we have already
      return new Promise((resolve) => {
        resolve(this._session)
      })
    } else {
      // If we don't have session data (or forceUpdate is true) then get it
      return new Promise((resolve, reject) => {
        let xhr = new XMLHttpRequest()
        xhr.open("GET", '/auth/session', true)
        xhr.onreadystatechange = () => {
          if (xhr.readyState == 4) {
            if (xhr.status == 200) {
              // Update session with session info
              this._session = JSON.parse(xhr.responseText)

              // Save changes to session
              this._setSessionStore(this._session)

              resolve(this._session)
            } else {
              reject(Error('XMLHttpRequest failed: Unable to get session'))
            }
          }
        }
        xhr.onerror = () => {
          reject(Error('XMLHttpRequest error: Unable to get session'))
        }
        xhr.send()
      })
    }
  }

  async signin(email) {
    // Sign in to the server
    return new Promise(async (resolve, reject) => {
      if (typeof window === 'undefined')
        return reject(Error('This method should only be called on the client'))

      // Make sure we have session in memory
      this._session = await this.getSession()

      let xhr = new XMLHttpRequest()
      xhr.open("POST", '/auth/signin', true)
      xhr.setRequestHeader("Content-type", "application/json")
      xhr.onreadystatechange = () => {
        if (xhr.readyState == 4) {
          if (xhr.status == 200) {
            return resolve(true)
          } else {
            return reject(Error('XMLHttpRequest error: Error while attempting to signin'))
          }
        }
      }
      xhr.onerror = () => {
        return reject(Error('XMLHttpRequest error: Unable to signin'))
      }
      xhr.send(JSON.stringify(email))

    })
  }

  async signout() {
    // Signout from the server
    return new Promise(async (resolve, reject) => {
      if (typeof window === 'undefined')
        return reject(Error('This method should only be called on the client'))

      // Make sure we have session in memory
      this._session = await this.getSession()

      // Set isLoggedIn to false and destory user object
      this._session.isLoggedIn = false
      delete this._session.user

      // Save changes to session
      this._setSessionStore(this._session)

      let xhr = new XMLHttpRequest()
      xhr.open("POST", '/auth/signout', true)
      xhr.onreadystatechange = () => {
        if (xhr.readyState == 4) {
          // @TODO We aren't checking for success, just completion
          resolve(true)
        }
      }
      xhr.onerror = () => {
        reject(Error('XMLHttpRequest error: Unable to signout'))
      }
      xhr.send()
    })
  }

  // localStorage is widely supported, but not always available (for example
  // it can be restricted in private browsing mode). We handle that by just
  // returning an empty session, forcing getSession() to perform an ajax request
  // to get the session info each time it is called.
  _getSessionStore() {
    try {
      return JSON.parse(localStorage.getItem('session'))
    } catch (e) {
      return {}
    }
  }

  _setSessionStore(session) {
    try {
      localStorage.setItem('session', JSON.stringify(session))
      return true
    } catch (e) {
      return false
    }
  }

}
