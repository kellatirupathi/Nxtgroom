sdfdfsd

# UI

## page 1 (login/signup)

- username
- password
- forgot pass (just place holder)

## page 2 (for admin)

- boa create, manage,edit users
- see all boas
- all access to boa data

## page3

- main page
- add,edit delete instructers
- view attendence(sidebar)
- view all instructor(sidebar)
- onClick(attendence) → card form where upload image + select instructor profile (default page)
- after submit form, image go for ai analysis in background and ready for new input
- select check in/out
- location check-in/out-time date by default stored in database
- when multiple check-in/out made keep latest data

## page4 (all instructor page)

- sidebar same as page 3
- view all instructor data in tabular view
- columns are : name, role, status(enum: pending/done/fail), remark, check_in_time, check_out_time, location, date
- when image anlysis done , send a email to admin and instructor about remark
- view (default) today's data
- onClick(any row → select that instructor data)

## page5 (select that instructor data)

- show a card with instructor information
- a detail analysis report of ai
- also show instructor on/off duty
